// Effective capabilities only; adapters supply parsed sources and physical path observations.
function providerConfiguration(S, observations) {
  const vendor = observations.vendor, facts = observations.facts || {}, unknown = (facts.unknown || []).map(value => ['provider version unavailable', 'unsupported provider configuration version', 'ConfigChange enforcement unavailable in provider version'].includes(value) ? value : 'provider observation unavailable')
  if (vendor === 'claude' && !facts.deliveryKnown) unknown.push('claude: mandatory server/MDM policy delivery facts unavailable')
  for (const source of observations.capabilitySources || []) {
    if (source.applicable === false || source.status === 'absent') continue
    if (source.status === 'directory' && Array.isArray(source.entries) && !source.entries.length) continue
    unknown.push(`${vendor}: unsupported or unreadable executable capability source`)
  }
  for (const source of observations.mcpSources || []) {
    if (!source.servers || typeof source.servers !== 'object' || Array.isArray(source.servers) || Object.keys(source.servers).length) unknown.push(`${vendor}: unsupported MCP capability source`)
  }
  const selectedProfile = observations.profile || (observations.layers || []).filter(l => l.applicable !== false && l.scope !== 'project' && l.data?.profile).map(l => l.data.profile).at(-1)
  let foundProfile = false
  const grants = [], security = { version: 1, vendor, layers: [], plugins: [], enforcement: {
    immutable: !!facts.immutable, hooks: !!facts.hooks, providerVersion: facts.version || null, deliveryKnown: !!facts.deliveryKnown, managedImmutable: !!facts.managedImmutable, tools: observations.tools || [],
    escalation: vendor === 'codex' ? 'never' : null, guard: vendor === 'claude' ? 'pretool-configchange-v1' : null, statusLine: vendor === 'claude' ? 'no-op' : null,
  } }
  const issue = (source, key, message) => unknown.push(`${vendor}: source[${(observations.layers || []).findIndex(layer => layer.source === source)}]: ${message}`)
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  const strings = v => Array.isArray(v) && v.every(x => typeof x === 'string')
  for (const layer of observations.layers || []) {
    const source = layer.source, data = layer.data
    if (layer.applicable === false) continue
    if (!object(data)) { issue(source, '<root>', 'invalid settings object'); continue }
    const bound = {}
    const grant = (value, key, pattern = false) => {
      if (typeof value !== 'string' || !value || value.includes('\0') || /[${}\[\]\\]/.test(value) || (/[?*]/.test(value) && value.split('/').includes('..'))) { issue(source, key, 'unbounded/unsupported write grant'); return }
      const wildcard = value.search(/[?*]/)
      let root = wildcard < 0 ? value : value.slice(0, value.lastIndexOf('/', wildcard) + 1)
      if (!root || root === '/' || root === '//') { issue(source, key, 'unbounded write pattern'); return }
      grants.push({ value: root, source, base: layer.base, key, pattern })
    }
    const roots = (v, key) => { if (!strings(v)) issue(source, key, 'invalid root list'); else v.forEach(x => grant(x, key)) }
    const rules = (v, key, writes) => {
      if (!strings(v)) { issue(source, key, 'invalid permission rules'); return }
      for (const rule of v) {
        if (typeof rule !== 'string') { issue(source, key, 'invalid permission'); continue }
        if (/^(Read|Glob|Grep)(\(.*\))?$/.test(rule)) continue
        const file = /^(?:Edit|Write|write_file)\(([^)]+)\)$/.exec(rule)
        if (file && writes) { grant(file[1], key, true); continue }
        if (/^Bash\([^\n]+\)$/.test(rule) && vendor === 'claude' && facts.hooks && observations.shellBounded) continue
        issue(source, key, 'unbounded permission')
      }
      bound[key] = [...v].sort()
    }
    const check = (v, schema, prefix = '') => {
      if (!object(v)) { issue(source, prefix, 'invalid object'); return }
      for (const [key, value] of Object.entries(v)) {
        const path = prefix ? `${prefix}.${key}` : key, type = Object.hasOwn(schema, key) ? schema[key] : null
        if (!type) { issue(source, path, 'unsupported settings key'); continue }
        if (type === 'renderer') { if (!['default', 'fullscreen'].includes(value)) issue(source, path, 'invalid presentation renderer') }
        else if (type.startsWith && type.startsWith('presentation:')) {
          if (typeof value !== type.slice(13)) issue(source, path, 'invalid presentation field')
        } else if (type === 'notifications') {
          if (typeof value !== 'boolean' && !strings(value)) issue(source, path, 'invalid presentation field')
        } else if (type === 'boolean' || type === 'string' || type === 'number') {
          if (typeof value !== type) issue(source, path, `expected ${type}`); else bound[path] = value
        } else if (type === 'roots') roots(value, path)
        else if (type === 'allow') rules(value, path, true)
        else if (type === 'deny') { if (!strings(value)) issue(source, path, 'invalid permission rules'); else bound[path] = [...value].sort() }
        else if (type === 'false') { if (value !== false) issue(source, path, 'unsupported control'); bound[path] = value }
        else if (type === 'inactive') {
          const valid = path.endsWith('approval_policy') ? ['never', 'on-request', 'on-failure', 'untrusted'].includes(value)
            : path.endsWith('sandbox_mode') ? ['read-only', 'workspace-write', 'danger-full-access'].includes(value)
            : path.endsWith('defaultMode') ? ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'].includes(value)
            : typeof value === 'boolean'
          if (!valid) issue(source, path, 'unsupported overridden control')
          bound[path] = 'invocation-override'
        }
        else if (type === 'string-map') { if (!object(value) || Object.values(value).some(x => typeof x !== 'string')) issue(source, path, 'invalid presentation map') }
        else if (type === 'plugin-map') {
          if (!object(value)) { issue(source, path, 'invalid plugin activation map'); continue }
          bound[path] = value
          for (const [name, entry] of Object.entries(value)) {
            if (!object(entry) || typeof entry.enabled !== 'boolean' || Object.keys(entry).some(k => k !== 'enabled')) issue(source, path, 'unsupported plugin activation or MCP override')
            else if (entry.enabled && (name === '_default' || !(observations.plugins || []).some(p => p.source === name && p.inspected))) issue(source, path, 'unresolved active plugin capability')
          }
        }
        else if (type === 'marketplaces') {
          if (!object(value)) { issue(source, path, 'invalid marketplace map'); continue }
          bound[path] = value
          for (const entry of Object.values(value)) {
            if (!object(entry) || typeof entry.source !== 'string' || !['git', 'local'].includes(entry.source_type) || (entry.ref !== undefined && typeof entry.ref !== 'string') || (entry.sparse_paths !== undefined && !strings(entry.sparse_paths)) || Object.keys(entry).some(k => !['source', 'source_type', 'ref', 'sparse_paths'].includes(k))) issue(source, path, 'unsupported marketplace source capability')
          }
          if (Object.keys(value).length && !facts.catalogsBounded) issue(source, path, 'unresolved marketplace refresh capability')
        }
        else if (type === 'claude-marketplaces') {
          if (!object(value)) { issue(source, path, 'invalid marketplace map'); continue }
          bound[path] = value
          for (const entry of Object.values(value)) {
            const catalog = entry?.source
            if (!object(entry) || Object.keys(entry).some(k => k !== 'source') || !object(catalog)) { issue(source, path, 'unsupported marketplace source capability'); continue }
            const fields = catalog.source === 'github' ? ['source', 'repo', 'ref', 'path'] : catalog.source === 'git' ? ['source', 'url', 'ref', 'path'] : ['file', 'directory'].includes(catalog.source) ? ['source', 'path'] : catalog.source === 'url' ? ['source', 'url', 'headers'] : []
            const required = catalog.source === 'github' ? 'repo' : ['git', 'url'].includes(catalog.source) ? 'url' : 'path'
            if (!fields.length || typeof catalog[required] !== 'string' || Object.keys(catalog).some(k => !fields.includes(k)) || Object.entries(catalog).some(([k,v]) => k === 'headers' ? !object(v) || Object.values(v).some(x => typeof x !== 'string') : typeof v !== 'string')) issue(source, path, 'unsupported marketplace executable/helper capability')
          }
          if (Object.keys(value).length && !facts.catalogsBounded) issue(source, path, 'unresolved marketplace refresh capability')
        }
        else if (type === 'auto-mode') {
          if (!object(value) || Object.entries(value).some(([k,v]) => k === 'classifyAllShell' ? typeof v !== 'boolean' : !['environment', 'allow', 'soft_deny', 'hard_deny'].includes(k) || !strings(v))) issue(source, path, 'invalid auto mode rules')
          if (!['plan', 'acceptEdits'].includes(observations.permissionMode)) issue(source, path, 'unbounded auto mode enforcement')
          bound[path] = 'invocation-inactive'
        }
        else if (type === 'empty') { if ((!object(value) && !Array.isArray(value)) || Object.keys(value).length) issue(source, path, 'unsupported executable capability'); }
        else if (type === 'statusLine') { if (!observations.statusLineOverride || !object(value) || value.type !== 'command' || typeof value.command !== 'string' || Object.keys(value).some(k => !['type', 'command', 'padding'].includes(k))) issue(source, path, 'unsupported presentation command'); }
        else if (Array.isArray(type)) { if (!type.includes(value)) issue(source, path, 'unsupported control'); else bound[path] = value }
        else check(value, type, path)
      }
    }
    if (vendor === 'codex') {
      const schema = { model: 'presentation:string', model_provider: ['openai'], model_reasoning_effort: 'presentation:string', model_reasoning_summary: 'presentation:string', model_verbosity: 'presentation:string', personality: 'presentation:string', service_tier: 'presentation:string',
        approval_policy: 'inactive', approvals_reviewer: ['user', 'guardian_subagent'], sandbox_mode: 'inactive',
        sandbox_workspace_write: { writable_roots: 'roots', network_access: 'boolean', exclude_slash_tmp: 'boolean', exclude_tmpdir_env_var: 'boolean' },
        tui: { notifications: 'notifications', animations: 'presentation:boolean', alternate_screen: 'presentation:string', show_tooltips: 'presentation:boolean' },
        hide_agent_reasoning: 'presentation:boolean', show_raw_agent_reasoning: 'presentation:boolean', check_for_update_on_startup: 'presentation:boolean',
        notice: { hide_full_access_warning: 'presentation:boolean', 'hide_gpt-5.1-codex-max_migration_prompt': 'presentation:boolean', hide_gpt5_1_migration_prompt: 'presentation:boolean', hide_rate_limit_model_nudge: 'presentation:boolean', hide_world_writable_warning: 'presentation:boolean', model_migrations: 'string-map' },
        plugins: 'plugin-map', marketplaces: 'marketplaces',
        notify: 'empty', hooks: 'empty', mcp_servers: 'empty', model_providers: 'empty', features: 'empty',
      }
      const common = { ...data }; delete common.projects; delete common.profiles; delete common.profile
      check(common, schema)
      if (data.projects !== undefined) {
        if (!object(data.projects)) issue(source, 'projects', 'invalid trust table')
        else for (const [path, entry] of Object.entries(data.projects)) {
          if (!object(entry) || Object.keys(entry).some(k => k !== 'trust_level') || !['trusted', 'untrusted'].includes(entry.trust_level)) issue(source, `projects.${path}`, 'unsupported trust entry')
        }
      }
      const profile = selectedProfile
      if (data.profiles !== undefined) {
        if (!object(data.profiles)) issue(source, 'profiles', 'invalid profiles')
        // Project profile merge/selection semantics are not established provider facts.
        // Check every applicable definition and union its grants without masking user grants.
        else if (layer.scope === 'project') {
          for (const [name, definition] of Object.entries(data.profiles)) check(definition, schema, `profiles.${name}`)
        } else if (profile && data.profiles[profile] !== undefined) {
          foundProfile = true
          if (!object(data.profiles[profile])) issue(source, `profiles.${profile}`, 'invalid selected profile')
          else check(data.profiles[profile], schema, `profiles.${profile}`)
        }
      }
    } else if (vendor === 'claude') {
      const common = { ...data }; delete common.enabledPlugins; delete common.outputStyle
      check(common, { tui: 'renderer', autoMode: 'auto-mode', model: 'presentation:string', effortLevel: 'presentation:string', language: 'presentation:string', theme: 'presentation:string', preferredNotifChannel: 'presentation:string',
        permissions: { allow: 'allow', deny: 'deny', ask: 'deny', additionalDirectories: 'roots', defaultMode: 'inactive', disableBypassPermissionsMode: ['disable'] },
        sandbox: { enabled: 'inactive', failIfUnavailable: 'inactive', autoAllowBashIfSandboxed: 'inactive', allowUnsandboxedCommands: 'false',
          excludedCommands: 'empty', filesystem: { allowWrite: 'roots', denyWrite: 'deny', denyRead: 'deny', disabled: 'false' } },
        disableAllHooks: 'false', allowManagedHooksOnly: 'false', dangerouslyDisableSandbox: 'false',
        hooks: 'empty', mcpServers: 'empty', statusLine: 'statusLine', apiKeyHelper: 'empty', agent: 'empty',
        autoUpdatesChannel: 'presentation:string', alwaysThinkingEnabled: 'presentation:boolean', spinnerTipsEnabled: 'presentation:boolean',
        includeCoAuthoredBy: 'presentation:boolean', cleanupPeriodDays: 'presentation:number', env: 'empty', extraKnownMarketplaces: 'claude-marketplaces',
      })
      if (data.enabledPlugins !== undefined && (!object(data.enabledPlugins) || Object.values(data.enabledPlugins).some(x => typeof x !== 'boolean'))) issue(source, 'enabledPlugins', 'invalid enabled plugin map')
      if (data.outputStyle !== undefined && typeof data.outputStyle !== 'string') issue(source, 'outputStyle', 'invalid style')
    } else if (vendor === 'gemini') {
      check(data, { toolPermission: ['proceed-in-sandbox'], permissions: { allow: 'allow', deny: 'deny', additionalDirectories: 'roots' }, sandbox: { filesystem: { allowWrite: 'roots' } }, model: 'presentation:string' })
    } else issue(source, '<vendor>', 'unsupported provider')
    if (Object.keys(bound).length) security.layers.push({ source, capabilities: bound })
  }
  if (vendor === 'codex' && selectedProfile && !foundProfile) unknown.push('codex: selected profile unavailable')
  for (const plugin of observations.plugins || []) {
    if (plugin.unknown?.length) plugin.unknown.forEach(() => issue(plugin.source, 'plugin', 'unsupported plugin component'))
    if (plugin.hooks || plugin.mcp || plugin.lsp || plugin.startup) issue(plugin.source, 'plugin', 'unsupported executable capability')
    if (!plugin.inspected) issue(plugin.source, 'plugin', 'unresolved plugin')
    security.plugins.push({ source: plugin.source, executable: plugin.executable || [], activation: plugin.activation || {} })
  }
  if (!facts.immutable && !(vendor === 'claude' && facts.hooks)) unknown.push('provider cannot bound settings reload')
  security.trust = observations.trust || []
  return { unknown, grants, security, diagnostic: providerDiagnostic(S, observations, unknown) }
}

// The set is configuration-derived, never selected by task prose or catalog membership.
function reachableProviders(S, request) {
  const raw = { ...(request.args || {}), host: 'codex' }, workflowName = request.workflow || 'factory', routes = []
  const add = (seat, role, reason) => { if (seat) routes.push({ vendor: seat.vendor, role, reason }) }
  const configRoutes = (config, reason, factoryContext = false) => {
    config.lineup.forEach(s => add(s, 'author', reason))
    if (!raw.mode || config.mode === 'implement' || config.tier === 'architecture' || config.pairOptions || config.ensemble) config.auditors.forEach(s => add(s, 'review', reason))
    config.panel.forEach(s => add(s, 'panel', reason))
    config.specReviewers.forEach(s => add(s, 'spec-review', reason))
    for (const [role, seat] of Object.entries(config.roles || {})) {
      const reachable = role === 'setup' || (role === 'checker' && !config.pairOptions)
        || (role === 'questions' && !config.pairOptions && !config.simple && !config.ensemble)
        || (role === 'spec' && config.specReviewers.length > 0)
        || (role === 'retro' && config.retro && !config.ensemble && (!config.pairOptions || factoryContext))
        || (role === 'record' && factoryContext)
      if (reachable) add(seat, role, reason)
    }
    if (config.ensemble) add(config.ensemble.compare, 'comparison', reason)
  }
  if (request.help) return []
  if (raw.explain && ['pair', 'ensemble'].includes(workflowName)) return []
  if (workflowName === 'pair') configRoutes(parsePairConfig(raw), 'pair')
  else if (workflowName === 'ensemble') configRoutes(parseEnsembleConfig(raw), 'ensemble')
  else if (workflowName === 'council') configRoutes(parseConfig(raw), 'council')
  else if (workflowName === 'factory') {
    const factory = parseFactory(raw), roles = parseRoles(raw), strategy = raw.strategy || 'auto'
    if (!['auto', 'pair', 'independent'].includes(strategy)) throw new Error('strategy must be auto, pair, or independent.')
    if (strategy === 'pair' && raw.mode && raw.mode !== 'implement') throw new Error('Pair strategy requires implementation.')
    add(roles.intake, 'intake', 'factory')
    if (!raw.explain) {
      // Enumerate only intake choices or later tiers reachable from the requested tier.
      const tiers = !factory.tier || factory.tier === 'simple' ? ['simple', 'fix', 'feature', 'architecture']
        : factory.tier === 'feature' ? ['feature', 'architecture'] : [factory.tier]
      for (const tier of tiers) {
        if (strategy === 'pair' && tier === 'architecture') continue
        const config = parseConfig(tierArgs(raw, tier, { mode: 'implement' }), { workflow: 'factory', tier })
        const state = { ...config, factory: { ...factory, tier }, raw }
        if (strategy !== 'pair') configRoutes(config, tier, true)
        if (strategy !== 'independent' && tier !== 'architecture' && (!raw.mode || raw.mode === 'implement')) {
          const selected = factoryStrategy(state, { strategy: 'pair', mode: 'implement' })
          if (selected === 'pair') configRoutes(factoryPairConfig(state), `${tier}:pair`, true)
        }
      }
      if (strategy === 'pair' && factory.tier === 'architecture') throw new Error('Pair strategy requires an implementation below Architecture.')
    }
  } else throw new Error('Unsupported pinned workflow')
  return routes.filter((r, i) => routes.findIndex(x => x.vendor === r.vendor && x.role === r.role && x.reason === r.reason) === i)
}

// This projection contains labels and categories only, never source values or absolute paths.
function providerDiagnostic(S, observations, unknown) {
  return { type: 'pin.admission', vendor: ['codex', 'claude', 'gemini'].includes(observations.vendor) ? observations.vendor : 'unknown',
    status: observations.stage === 'watching' ? 'watching' : unknown.length ? 'refused' : 'admitted',
    sources: (observations.layers || []).map((layer, index) => ({ scope: ['system', 'user', 'managed', 'project'].includes(layer.scope) ? layer.scope : 'source', name: ['config.toml', 'settings.json', 'settings.local.json', 'managed-settings.json', 'managed-settings.d', 'policy', 'component'].includes(layer.name) ? layer.name : 'component', index })),
    roles: (observations.roles || ['seat']).filter(role => ['seat', 'author', 'review', 'reviewer', 'setup', 'checker', 'intake', 'panel', 'spec', 'spec-review', 'comparison', 'retro', 'record'].includes(role)),
    capabilities: ['write-roots', 'permissions', 'executable-activation', 'hook-enforcement'],
    invalidation: 'Persistent approvals changing watched capabilities invalidate this run; one-time approvals without source changes do not.',
    reasons: unknown.length ? ['unknown-capabilities'] : [] }
}
