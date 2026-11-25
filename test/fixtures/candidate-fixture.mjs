// The one statement a fixture candidate adds, so its bytes and marker differ from the shipped build's.
export const FIXTURE_STATEMENT = '\nglobalThis.__candidateFixture = 1\n'

// A copy of a workflow set (file name to bytes) whose named workflow ends with the statement.
export function withFixture(bytes, name = 'factory.js') {
  return Object.freeze({ ...bytes, [name]: Buffer.concat([bytes[name], Buffer.from(FIXTURE_STATEMENT)]) })
}
