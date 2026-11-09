<?php
// Independent frozen trial probes. Never supplied to either arm's agents.
declare(strict_types=1);
require $argv[1] . '/vendor/autoload.php';
$results = [];
set_error_handler(static function (int $severity, string $message): never {
    throw new ErrorException($message, 0, $severity);
});
function probe(string $name, callable $check): void {
    global $results;
    try {
        $results[$name] = ['passed' => $check() === true];
    } catch (Throwable $e) {
        $results[$name] = ['passed' => false, 'error' => get_class($e) . ': ' . $e->getMessage()];
    }
}
if ($argv[2] === 'iterator-pad-left') {
    foreach ([0, 1, 3] as $length) {
        probe("bounded-first-$length", static function () use ($length): bool {
            $source = (static function () use ($length): Generator {
                for ($i = 0; $i < max(1, $length); ++$i) { yield $i; }
                throw new RuntimeException('over-read before first output');
            })();
            return IterTools\Single::padLeft($source, $length, null)->current() === 0;
        });
    }
    probe('empty', static fn(): bool => iterator_to_array(IterTools\Single::padLeft([], 2, null)) === [null, null]);
    probe('short', static fn(): bool => iterator_to_array(IterTools\Single::padLeft(['x' => 9], 3, 0)) === [0, 0, 9]);
    probe('long', static fn(): bool => iterator_to_array(IterTools\Single::padLeft(['x' => 9, 'y' => 8, 'z' => 7], 2, 0)) === [9, 8, 7]);
    probe('negative-lazy', static function (): bool {
        $g = IterTools\Single::padLeft([], -1, null);
        try { $g->current(); } catch (InvalidArgumentException) { return true; }
        return false;
    });
    probe('stream', static fn(): bool => IterTools\Stream::of([3])->padLeft(3, 1)->toArray() === [1, 1, 3]);
} elseif ($argv[2] === 'algebra-coprime-api') {
    // Integer expectations are mathematical gcd == 1; no source implementation is used as an oracle.
    foreach ([[8, 15, true], [8, 12, false], [-8, 15, true], [0, 0, false], [0, 1, true], [0, -1, true], [0, 2, false], [PHP_INT_MIN, 0, false], [PHP_INT_MIN, PHP_INT_MIN, false], [PHP_INT_MIN, 1, true], [PHP_INT_MIN, -1, true], [PHP_INT_MIN, 2, false], [PHP_INT_MIN, PHP_INT_MAX, true]] as [$a, $b, $expected]) {
        probe("coprime-$a-$b", static fn(): bool => MathPHP\Algebra::areCoprime($a, $b) === $expected && MathPHP\Algebra::areCoprime($b, $a) === $expected);
    }
    probe('preserved-gcd', static fn(): bool => MathPHP\Algebra::gcd(-8, 12) === 4 && MathPHP\Algebra::extendedGcd(8, 12)[0] === 4);
} else {
    // Closed form for two equal absolute components: scale * 2**(1/p).
    foreach ([1, 2, 3, 20] as $p) {
        foreach ([1e200, 1e-200, 1.0] as $scale) {
            probe("scale-$p-$scale", static function () use ($p, $scale): bool {
                $actual = (new MathPHP\LinearAlgebra\Vector([$scale, -$scale]))->pNorm($p);
                $expected = $scale * 2 ** (1 / $p);
                return is_finite((float) $actual) && abs($actual / $expected - 1) < 1e-12;
            });
        }
    }
    probe('zero', static fn(): bool => (new MathPHP\LinearAlgebra\Vector([0, 0]))->pNorm(2) == 0);
    probe('mixed', static fn(): bool => abs((new MathPHP\LinearAlgebra\Vector([-1e200, 1e-200]))->pNorm(3) / 1e200 - 1) < 1e-12);
    probe('infinity', static fn(): bool => (new MathPHP\LinearAlgebra\Vector([-INF, 1]))->pNorm(2) === INF);
    probe('nan', static fn(): bool => is_nan((new MathPHP\LinearAlgebra\Vector([INF, NAN]))->pNorm(2)));
}
echo json_encode($results, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
exit(count(array_filter($results, static fn(array $r): bool => !$r['passed'])) ? 1 : 0);
