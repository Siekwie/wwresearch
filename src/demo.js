// Demo mode: a scripted swarm on a problem everybody knows — the irrationality
// of √2. No model, no API key, no cost. The simulated agents talk to the real
// board over HTTP and are managed by the real orchestrator, so what you watch
// is the actual protocol: duplicate ideas get redirected, dead ends become
// knowledge, partial results get continued, and proofs are reviewed by agents
// that did not write them (one of them is caught being wrong).

export const DEMO_GOAL = `Prove that √2 is irrational, i.e. that there are no positive integers p, q with p² = 2q².

Any rigorous proof counts. Find as many genuinely different proofs as you can — and say clearly when an approach does not work.`;

export const DEMO_TITLE = 'Prove that √2 is irrational';

const CLAIM = '√2 is irrational: there are no positive integers p, q with p² = 2q².';

/**
 * Every approach the simulated agents know. `requires` delays an approach
 * until another one has reached a state (it builds on that card).
 */
export const APPROACHES = [
  {
    key: 'parity',
    title: 'Parity contradiction',
    idea: 'Assume √2 = p/q in lowest terms and derive a contradiction from parity: p² = 2q² forces p to be even, and then q to be even as well.',
    approach: 'Assume √2 = p/q in lowest terms. From p² = 2q² show that p is even, substitute p = 2k, and show that q is even too — contradicting lowest terms.',
    steps: [
      { note: 'Setup: √2 = p/q with gcd(p, q) = 1, hence p² = 2q².' },
      { note: 'Needed lemma: n² even ⇒ n even. Contrapositive: (2k+1)² = 4k² + 4k + 1 is odd.' },
      { finding: { kind: 'lemma', confidence: 'proven', statement: 'If n² is even then n is even, because the square of an odd number is odd: (2k+1)² = 2(2k² + 2k) + 1.' } },
      { note: 'p = 2k gives 4k² = 2q², so q² = 2k² and q is even by the same lemma. Both even — contradiction.' },
    ],
    outcome: {
      type: 'proof',
      claim: CLAIM,
      summary: 'Classic proof by contradiction using only the parity of p and q.',
      assumptions: 'Every fraction can be written in lowest terms.',
      proof:
        'Suppose √2 = p/q with positive integers p, q and gcd(p, q) = 1. Then p² = 2q², so p² is even. The square of an odd number is odd ((2k+1)² = 2(2k² + 2k) + 1), hence p is even: p = 2k. Substituting gives 4k² = 2q², i.e. q² = 2k², so q² is even and therefore q is even. Now 2 divides both p and q, contradicting gcd(p, q) = 1. Hence no such fraction exists.',
    },
    review: {
      verdict: 'verified',
      what_was_found: 'A complete proof that √2 cannot be written as a fraction. It assumes a fraction in lowest terms exists and shows that numerator and denominator would both have to be even, which is impossible for a fraction in lowest terms.',
      assessment:
        'I checked each step separately. (1) p² = 2q² follows from squaring. (2) "n² even ⇒ n even" is proved inside the proof via the contrapositive and is correct. (3) The substitution p = 2k is carried out correctly. (4) The final contradiction uses only gcd(p, q) = 1, which was assumed at the start. I found no hidden assumption and no circular step; the claim matches the goal exactly.',
      independent_test:
        'Option A (formal): install Lean 4 with Mathlib and run `#check irrational_sqrt_two`. It type-checks, which means a machine-verified proof of the same statement exists.\nOption B (brute force): in any language with big integers, loop q from 1 to 1,000,000 and confirm that 2·q² is never a perfect square (compare isqrt(2q²)² with 2q²).',
      why_independent:
        'Option A relies on a proof written by other people years ago and checked by the Lean kernel — nothing produced in this research enters it. Option B uses no reasoning at all, only integer arithmetic, so it cannot inherit a mistake from the argument above.',
    },
  },
  {
    key: 'factorization',
    title: 'Exponent of 2 on both sides',
    idea: 'Use unique prime factorization: compare how often the prime 2 divides the two sides of p² = 2q².',
    approach: 'Count the exponent of the prime 2 on both sides of p² = 2q². On the left it is even, on the right it is odd — impossible if the exponent is well defined.',
    steps: [
      { note: 'Write v(n) for the exponent of 2 in n. Then v(p²) = 2·v(p) is even and v(2q²) = 1 + 2·v(q) is odd.' },
      { finding: { kind: 'lemma', confidence: 'proven', statement: 'For every integer n ≥ 1 the exponent of 2 in n² is even: v(n²) = 2·v(n).' } },
      { note: 'This leans on unique factorization. I have not written out that dependency — could it be circular? Leaving it as the open step.' },
    ],
    outcome: {
      type: 'derivation',
      established: 'If the exponent of 2 is well defined and additive, then p² = 2q² would force an even number to equal an odd number.',
      next_step: 'Close the gap: show that v(n), the largest k with 2^k dividing n, is well defined and satisfies v(ab) = v(a) + v(b) WITHOUT invoking the full fundamental theorem of arithmetic. Then finish the proof.',
      followup_title: 'Make the exponent-of-2 argument self-contained',
      confidence: 'likely',
      open_questions: 'Does additivity of v need unique factorization, or is "odd × odd = odd" enough?',
    },
    followup: {
      steps: [
        { note: 'v(n) is well defined for n ≥ 1: the k with 2^k | n form a finite, non-empty set (k = 0 is in it).' },
        { note: 'Additivity: write a = 2^i·a′ and b = 2^j·b′ with a′, b′ odd. Then ab = 2^(i+j)·a′b′ and a′b′ is odd.' },
        { finding: { kind: 'lemma', confidence: 'proven', statement: 'v(ab) = v(a) + v(b) follows from "odd × odd = odd" alone. The fundamental theorem of arithmetic is not needed.', buildsOn: ['factorization:finding'] } },
      ],
      outcome: {
        type: 'proof',
        claim: CLAIM,
        summary: 'Proof by comparing the exponent of 2 on both sides, using only that a product of odd numbers is odd.',
        assumptions: 'None beyond basic integer arithmetic.',
        proof:
          'For n ≥ 1 let v(n) be the largest k such that 2^k divides n; it exists because only finitely many powers of 2 are ≤ n. Writing a = 2^i·a′ and b = 2^j·b′ with a′, b′ odd gives ab = 2^(i+j)·a′b′ with a′b′ odd, so v(ab) = v(a) + v(b). Suppose p² = 2q² with positive integers p, q. Then v(p²) = 2·v(p) is even, while v(2q²) = 1 + 2·v(q) is odd. Equal numbers have equal v, so an even number would equal an odd one — impossible.',
      },
      review: {
        verdict: 'verified',
        what_was_found: 'A second, different proof: it counts how many times 2 divides each side of p² = 2q² and finds an even count on one side and an odd count on the other.',
        assessment:
          'The worry inherited from the previous card was circularity through unique factorization. This proof avoids it: additivity of v is derived from "odd × odd = odd" only, which I verified directly ((2a+1)(2b+1) = 2(2ab + a + b) + 1). Well-definedness of v is argued correctly. The final parity comparison is immediate.',
        independent_test: 'Write a ten-line script: for all 1 ≤ p, q ≤ 2000 compute v(p²) and v(2q²) by repeated division by 2 and confirm that the first is always even and the second always odd.',
        why_independent: 'The script computes both quantities directly from the numbers. It does not use the additivity lemma, so if that lemma were wrong the script would expose it.',
      },
    },
  },
  {
    key: 'cf',
    title: 'Infinite continued fraction',
    idea: 'Show that the continued fraction of √2 never terminates — rational numbers have finite continued fractions.',
    approach: 'Compute the continued fraction expansion of √2. A real number is rational exactly when its expansion terminates, so an infinite expansion proves irrationality.',
    steps: [
      { note: 'Partial quotients come out as 1; 2, 2, 2, 2, … — first 60 computed with exact integer arithmetic, all equal to 2.' },
      { finding: { kind: 'observation', confidence: 'checked', statement: 'The first 60 partial quotients of the continued fraction of √2 are [1; 2, 2, 2, …] (computed exactly).' } },
      { note: 'The pattern is clearly stable. Writing it up as a proof.' },
    ],
    outcome: {
      type: 'proof',
      claim: '√2 is irrational because its continued fraction [1; 2, 2, 2, …] does not terminate.',
      summary: 'Rationals have finite continued fractions; the expansion of √2 is infinite.',
      proof:
        'A real number is rational if and only if its simple continued fraction is finite (this is the Euclidean algorithm). Computing the expansion of √2 gives 1 followed by 2, 2, 2, …; the first 60 partial quotients were computed exactly and all equal 2, so the pattern continues forever and the expansion is infinite. Hence √2 is irrational.',
    },
    review: {
      verdict: 'refuted',
      what_was_found: 'The submission is not a proof. Its idea is sound — rational numbers do have finite continued fractions — but the decisive step is an extrapolation from numerical data.',
      assessment:
        'The proof computes 60 partial quotients and concludes "the pattern continues forever". That sentence is precisely the statement that needs to be proved. Rational numbers can agree with √2 on any finite number of partial quotients, so 60 matching terms carry no logical weight.',
      flaws: 'Infinite expansion is inferred from 60 computed terms. Missing step: prove that the expansion repeats, e.g. from the exact identity √2 − 1 = 1/(2 + (√2 − 1)).',
      independent_test:
        'Run the Euclidean algorithm on the fraction 577/408: 577 = 1·408 + 169, 408 = 2·169 + 70, 169 = 2·70 + 29, 70 = 2·29 + 12, 29 = 2·12 + 5, 12 = 2·5 + 2, 5 = 2·2 + 1, 2 = 2·1. Its continued fraction is [1; 2, 2, 2, 2, 2, 2, 2] — it starts exactly like √2, and it is rational.',
      why_independent: 'The counterexample is a plain fraction you can check by hand in a minute. It does not depend on anything computed during the research, and it shows directly why "the first terms match" cannot prove the claim.',
    },
  },
  {
    key: 'rational-root',
    title: 'Rational root theorem on x² − 2',
    idea: 'Apply the rational root theorem to the polynomial x² − 2: its only possible rational roots are ±1 and ±2.',
    approach: '√2 is a root of the monic integer polynomial x² − 2. Any rational root of a monic integer polynomial is an integer dividing the constant term; check ±1 and ±2 directly.',
    steps: [
      { note: 'Candidates are ±1 and ±2. Their squares are 1 and 4 — neither is 2.' },
      { finding: { kind: 'technique', confidence: 'proven', statement: 'Any rational root of a monic polynomial with integer coefficients is an integer. For x² − 2 this reduces the irrationality of √2 to: no integer squares to 2.' } },
      { note: 'To stay self-contained I prove the one case of the theorem that is needed instead of citing it.' },
    ],
    outcome: {
      type: 'proof',
      claim: '√2 is irrational: the polynomial x² − 2 has no rational root.',
      summary: 'A rational root in lowest terms must have denominator 1, and no integer squares to 2.',
      assumptions: "Euclid's lemma: a prime dividing a product divides one of the factors.",
      proof:
        "Let p/q be a rational root of x² − 2 in lowest terms with q ≥ 1. Then p² = 2q², so q divides p². If a prime r divided q, it would divide p² and hence p (Euclid's lemma), contradicting gcd(p, q) = 1. So q has no prime factor, i.e. q = 1, and the root is an integer p with p² = 2. But 1² = 1 < 2 < 4 = 2², and integers of larger absolute value have larger squares. No integer squares to 2, so x² − 2 has no rational root.",
    },
    review: {
      verdict: 'verified',
      what_was_found: 'A proof via polynomials: a fraction that solves x² = 2 would have to be a whole number, and no whole number squares to 2.',
      assessment: "The argument proves the needed special case of the rational root theorem inline and uses Euclid's lemma exactly once, which is stated as an assumption. The integer check (1² < 2 < 2²) is complete. I found no gap.",
      independent_test: 'Ask a computer algebra system to factor x² − 2 over the rationals. In Python: `import sympy; x = sympy.symbols("x"); print(sympy.factor(x**2 - 2))` prints `x**2 - 2` (it does not split), whereas `sympy.factor(x**2 - 4)` prints `(x - 2)*(x + 2)`.',
      why_independent: 'The computer algebra system uses a general factorization algorithm for polynomials, implemented and tested independently of this research. It never sees the argument above.',
    },
  },
  {
    key: 'descent',
    title: 'Descent on the denominator',
    idea: 'Infinite descent: from one fraction p/q equal to √2 construct another fraction equal to √2 with a smaller denominator.',
    approach: 'If √2 = p/q, show that (2q − p)/(p − q) is also equal to √2 and has a strictly smaller positive denominator. Repeating forever is impossible for positive integers.',
    steps: [
      { note: 'Algebra: (2q − p)² − 2(p − q)² = 4q² − 4pq + p² − 2p² + 4pq − 2q² = 2q² − p² = 0 ✓' },
      { finding: { kind: 'lemma', confidence: 'proven', statement: 'If p² = 2q² then (2q − p)² = 2(p − q)². So (2q − p, p − q) is again a solution.' } },
      { note: 'Still missing: 0 < p − q < q. It should follow from 1 < √2 < 2 but I have not written it rigorously.' },
    ],
    outcome: {
      type: 'derivation',
      established: 'Every solution (p, q) of p² = 2q² yields another solution (2q − p, p − q).',
      next_step: 'Prove the size bound 0 < p − q < q for positive solutions, then conclude by infinite descent (well-ordering of the positive integers).',
      followup_title: 'Finish the descent: bound the new denominator',
      confidence: 'proven',
    },
    followup: {
      steps: [
        { note: 'From p² = 2q²: q² < p² < 4q², so q < p < 2q (everything positive).' },
        { finding: { kind: 'lemma', confidence: 'proven', statement: 'For positive integers with p² = 2q²: q < p < 2q, hence 0 < p − q < q and 2q − p > 0.', buildsOn: ['descent:finding'] } },
        { note: 'So the new solution is positive and strictly smaller. Descent closes.' },
      ],
      outcome: {
        type: 'proof',
        claim: CLAIM,
        summary: 'Infinite descent: every solution produces a strictly smaller one.',
        assumptions: 'Well-ordering of the positive integers.',
        proof:
          'Suppose positive integers p, q satisfy p² = 2q², and choose such a pair with q as small as possible. Since q² < 2q² = p² < 4q², we have q < p < 2q. Put p′ = 2q − p and q′ = p − q; both are positive integers and q′ < q. Moreover p′² − 2q′² = (4q² − 4pq + p²) − (2p² − 4pq + 2q²) = 2q² − p² = 0. So (p′, q′) is a solution with a smaller denominator — contradicting the choice of q.',
      },
      review: {
        verdict: 'verified',
        what_was_found: 'A proof by infinite descent: any fraction equal to √2 could be replaced by one with a smaller denominator, forever — which positive integers do not allow.',
        assessment: 'Two ingredients carry the proof: the identity p′² − 2q′² = 2q² − p², which I expanded independently, and the bound q < p < 2q, which follows from q² < p² < 4q². Both hold. Minimality is used correctly.',
        independent_test: 'Check the identity with a computer algebra system: expand (2q − p)² − 2(p − q)² − (2q² − p²) and confirm the result is 0. Then, for the bound, verify for all 1 ≤ q ≤ 10,000 that the integer p nearest to q·√2 satisfies q < p < 2q.',
        why_independent: 'The symbolic expansion is done by software rather than by following the proof, and the numeric check does not use the descent argument at all.',
      },
    },
  },
  {
    key: 'decimal',
    title: 'Search the decimal expansion for a period',
    idea: 'Compute many decimal digits of √2 and check that the expansion never becomes periodic.',
    approach: 'Compute √2 to a million decimal digits and test for eventual periodicity. A rational number has an eventually periodic expansion, so "no period" would mean irrational.',
    steps: [
      { note: 'Computed 1,000,000 digits via the integer square root of 2·10^2000000.' },
      { finding: { kind: 'observation', confidence: 'checked', statement: 'The first 1,000,000 decimal digits of √2 contain no eventual period of length ≤ 10,000 (numerical evidence only).' } },
      { note: 'Problem: a fraction with a huge denominator has a period far longer than anything I can inspect. Absence of a short period proves nothing.' },
    ],
    outcome: {
      type: 'dead_end',
      why_it_fails: 'No finite number of digits can rule out periodicity: the period of p/q can be as long as q − 1, so every finite prefix is consistent with a rational number of large enough denominator. Numerical evidence cannot prove irrationality.',
      salvageable: 'The digit data does rule out all fractions with a small denominator — consistent with the claim, but far weaker.',
    },
  },
  {
    key: 'mod4',
    requires: { key: 'parity', state: 'claimed' },
    title: 'Squares modulo 4',
    idea: 'Look at p² = 2q² modulo 4: squares are 0 or 1 modulo 4, which restricts the equation heavily.',
    approach: 'Squares are congruent to 0 or 1 modulo 4. Go through p² ≡ 2q² (mod 4) case by case to force p and q to share a factor.',
    differentBecause: 'Works with residues modulo 4 instead of a parity substitution; unclear yet whether it yields an independent argument.',
    steps: [
      { note: 'q odd ⇒ 2q² ≡ 2 (mod 4), which is not a square. q even ⇒ p² ≡ 0 (mod 4) ⇒ p even.' },
      { finding: { kind: 'observation', confidence: 'proven', statement: 'Working modulo 4 reproduces the parity proof: the only consistent case has p and q both even.', buildsOn: ['parity'] } },
      { note: 'So this ends at "p and q are both even" — the parity argument of {parity} with extra steps.' },
    ],
    outcome: {
      type: 'dead_end',
      why_it_fails: 'Collapses into the parity argument: the case analysis modulo 4 ends with "p and q are both even", which is exactly the classic proof. It is not an independent route.',
      salvageable: 'The same case analysis modulo 3 (squares are 0 or 1 mod 3) gives a proof that never mentions parity. Not pursued here.',
      buildsOn: ['parity'],
    },
  },
  {
    key: 'pell',
    title: 'Pell equation p² − 2q² = ±1',
    idea: 'Use the Pell equation: the best approximations p/q of √2 satisfy p² − 2q² = ±1, so p²/q² is never exactly 2.',
    approach: 'The convergents p/q of √2 satisfy p² − 2q² = ±1. Try to extend this to show p² − 2q² ≠ 0 for every fraction.',
    steps: [
      { note: 'Verified p² − 2q² = ±1 for 3/2, 7/5, 17/12, 41/29, 99/70 and the next 15 convergents.' },
      { finding: { kind: 'observation', confidence: 'checked', statement: 'The convergents p/q of √2 satisfy p² − 2q² = ±1 (checked for the first 20). They are generated by (p, q) → (p + 2q, p + q).' } },
      { note: 'This only covers convergents. For ALL fractions I would need "every best approximation is a convergent" — and that already assumes the expansion is infinite.' },
    ],
    outcome: {
      type: 'dead_end',
      why_it_fails: 'Circular: the Pell equation controls p² − 2q² only on the convergents. Extending it to every fraction requires knowing that the continued fraction never terminates, which is equivalent to the irrationality being proved.',
      salvageable: 'The recurrence (p, q) → (p + 2q, p + q) is the inverse of the descent step and may help a constructive variant.',
    },
  },
  {
    key: 'geometric',
    requires: { key: 'descent', state: 'claimed' },
    title: 'Folding the isosceles right triangle',
    idea: 'Geometric proof: an isosceles right triangle with integer sides would contain a smaller one, by folding a leg onto the hypotenuse.',
    approach: 'Take an isosceles right triangle with integer legs q and hypotenuse p. Fold one leg onto the hypotenuse; the leftover corner is a smaller isosceles right triangle with integer sides. Repeat.',
    differentBecause: 'A geometric construction rather than an algebraic identity; it may or may not be the same descent in disguise.',
    steps: [
      { note: 'Folding the leg onto the hypotenuse leaves a small triangle with legs p − q and hypotenuse 2q − p.' },
      { finding: { kind: 'observation', confidence: 'proven', statement: 'The paper-folding construction on the isosceles right triangle is the algebraic descent (p, q) → (2q − p, p − q) in geometric form.', buildsOn: ['descent:finding'] } },
      { note: 'That is exactly the map used in {descent}. Same proof, drawn instead of computed.' },
    ],
    outcome: {
      type: 'dead_end',
      why_it_fails: 'Not a new route: the folded triangle has sides (2q − p, p − q), which is exactly the descent step already on the board. The picture adds intuition but no independent proof.',
      salvageable: 'The folding picture is the best way to explain the descent proof to a human reader.',
      buildsOn: ['descent'],
    },
  },
  {
    key: 'cf-repair',
    requires: { key: 'cf', state: 'refuted' },
    title: 'Self-similar remainder: √2 − 1 = 1/(2 + (√2 − 1))',
    idea: 'Repair the refuted continued-fraction proof: derive the repetition from an exact identity instead of from computed terms.',
    approach: 'Fix the gap the reviewer found: use the exact identity x = 1/(2 + x) for x = √2 − 1 to show that a rational x would always admit a smaller denominator.',
    differentBecause: 'Replaces the numerical extrapolation that was refuted by an exact identity; the argument is a different one.',
    buildsOn: ['cf:refutation'],
    steps: [
      { note: 'Let x = √2 − 1. Then x(2 + x) = (√2 − 1)(√2 + 1) = 1, so 1/x = 2 + x exactly — no numerics involved.' },
      { finding: { kind: 'lemma', confidence: 'proven', statement: 'x = √2 − 1 satisfies 1/x = 2 + x exactly. Each step of the continued fraction algorithm therefore returns the same remainder.', buildsOn: ['cf:refutation'] } },
      { note: 'If x = a/b with b minimal, then x = b/a − 2 = (b − 2a)/a has denominator a < b. Contradiction.' },
    ],
    outcome: {
      type: 'proof',
      claim: CLAIM,
      summary: 'The remainder √2 − 1 reproduces itself under the continued fraction step, so the expansion provably never ends.',
      assumptions: 'Well-ordering of the positive integers.',
      buildsOn: ['cf:refutation'],
      proof:
        'Let x = √2 − 1, so 0 < x < 1 and x(x + 2) = (√2 − 1)(√2 + 1) = 1, i.e. 1/x = 2 + x. Suppose x is rational and write x = a/b with positive integers a, b and b as small as possible. Since x < 1 we have a < b. From 1/x = 2 + x we get x = b/a − 2 = (b − 2a)/a, so x is also a fraction with denominator a < b — contradicting the minimality of b. Hence x is irrational, and so is √2 = x + 1. (In continued-fraction terms: every step returns the same remainder x, so the expansion [1; 2, 2, 2, …] never ends — the step the refuted proof only observed numerically.)',
    },
    review: {
      verdict: 'verified',
      what_was_found: 'A repaired version of the continued-fraction idea. Instead of observing that the expansion "seems" to go on, it proves that it must, from one exact identity.',
      assessment: 'The identity x(x + 2) = 1 is exact: (√2 − 1)(√2 + 1) = 2 − 1. From it, x = (b − 2a)/a is a correct rearrangement, and a < b holds because x < 1. The minimal-denominator contradiction is valid. The flaw of the earlier attempt (extrapolating from 60 terms) is gone.',
      independent_test: 'Verify the identity numerically with any arbitrary-precision calculator: (√2 − 1)·(√2 + 1) = 1 to as many digits as you like. Then check the rearrangement on paper: from b/a = 2 + a/b it follows that a/b = (b − 2a)/a.',
      why_independent: 'The identity can be confirmed without reading the proof, and the rearrangement is two lines of school algebra you do yourself. Neither check uses anything produced by the research agents.',
    },
  },
];

// What each simulated researcher *wants* to do, in spawn order. Like real
// agents given the same prompt, most of them reach for the obvious approach.
const INTENDED = ['parity', 'parity', 'factorization', 'parity', 'cf', 'rational-root', 'parity', 'decimal', 'descent', 'factorization', 'pell', 'parity'];
// When an agent finds its idea taken, it looks for something not yet on the board.
const PIVOT_ORDER = ['rational-root', 'descent', 'decimal', 'mod4', 'pell', 'geometric', 'cf-repair', 'cf', 'factorization', 'parity'];

export const DEMO_IDEAS = INTENDED.length;

const BY_KEY = new Map(APPROACHES.map((a) => [a.key, a]));

/**
 * Build the spawnAgent function for the orchestrator.
 * @param {object} opts
 * @param {string} opts.apiUrl  base URL of the board, e.g. http://127.0.0.1:4777
 * @param {number} [opts.speed] time multiplier (2 = twice as fast)
 */
export function simRunner({ apiUrl, speed = 1 }) {
  const cardByKey = new Map(); // script key → card id ("descent", "descent>" for its follow-up)
  const keyByCard = new Map();
  const findingByKey = new Map(); // script key → first finding recorded on that card
  let researchers = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
  const jitter = (min, max) => min + Math.random() * (max - min);

  async function tool(name, args) {
    const res = await fetch(`${apiUrl}/api/tool/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const body = await res.json();
    if (!body.ok) throw Object.assign(new Error(body.text), { code: body.code });
    return body.data;
  }

  const state = async () => (await fetch(`${apiUrl}/api/state`)).json();

  async function resolveRef(ref) {
    const [key, what] = ref.split(':');
    if (!what) return cardByKey.get(key) ?? null;
    if (what === 'finding') return findingByKey.get(key) ?? null;
    const s = await state();
    const card = s.cards[cardByKey.get(key)];
    if (!card) return null;
    if (what === 'refutation') return Object.values(s.findings).find((f) => f.kind === 'refutation' && f.contradicts.includes(card.outcome?.findingId))?.id ?? null;
    return null;
  }

  const refs = async (list = []) => (await Promise.all(list.map(resolveRef))).filter(Boolean);
  const fill = (text) => text.replace(/\{([\w>-]+)\}/g, (_, key) => cardByKey.get(key) ?? 'an earlier card');

  async function available(key, s) {
    if (cardByKey.has(key)) return false;
    const req = BY_KEY.get(key).requires;
    if (!req) return true;
    const card = s.cards[cardByKey.get(req.key)];
    if (!card) return false;
    return req.state === 'claimed' || card.proofStatus === req.state;
  }

  async function work(token, key, script, alive) {
    for (const step of script.steps) {
      await sleep(jitter(2200, 3800));
      if (!alive()) return;
      if (step.note) await tool('note', { token, text: fill(step.note) });
      else {
        const { buildsOn, ...finding } = step.finding;
        const res = await tool('add_finding', { token, ...finding, builds_on: await refs(buildsOn) });
        if (!findingByKey.has(key)) findingByKey.set(key, res.findingId);
      }
    }
    await sleep(jitter(1800, 3000));
    if (!alive()) return;
    const { type, buildsOn, ...outcome } = script.outcome;
    const builds_on = await refs(buildsOn);
    if (type === 'proof') await tool('submit_proof', { token, ...outcome, builds_on });
    else if (type === 'derivation') await tool('submit_derivation', { token, ...outcome, builds_on });
    else await tool('report_dead_end', { token, ...outcome, builds_on });
  }

  async function researcher(token, n, alive) {
    const wanted = BY_KEY.get(INTENDED[n % INTENDED.length]);
    await sleep(jitter(1200, 3600)); // "thinking of an idea"
    let turn = await tool('join_queue', { token, idea: wanted.idea });
    for (;;) {
      if (!alive()) return;
      turn = await tool('wait_turn', { token });
      if (turn.status !== 'your_turn') continue;
      await sleep(jitter(1500, 2600)); // "reading the board"
      const s = await state();
      let pick = wanted;
      let pivotedFrom = null;
      if (cardByKey.has(wanted.key)) {
        pivotedFrom = cardByKey.get(wanted.key);
        pick = null;
        for (const key of PIVOT_ORDER) {
          if (await available(key, s)) {
            pick = BY_KEY.get(key);
            break;
          }
        }
      }
      if (!pick) {
        // Nothing new to add right now. If an approach is still locked behind a
        // pending result, come back later; otherwise leave.
        const locked = APPROACHES.some((a) => !cardByKey.has(a.key) && a.requires);
        if (!locked) return void (await tool('pass_turn', { token }));
        await tool('pass_turn', { token, new_idea: wanted.idea });
        await sleep(4000);
        continue;
      }
      const args = { token, title: pick.title, approach: pick.approach, pivoted_from: pivotedFrom ?? undefined, builds_on: await refs(pick.buildsOn) };
      let res = await tool('claim_card', args);
      if (!res.claimed) res = await tool('claim_card', { ...args, different_because: pick.differentBecause ?? 'Uses a different mechanism than the look-alike card.' });
      cardByKey.set(pick.key, res.cardId);
      keyByCard.set(res.cardId, pick.key);
      return work(token, pick.key, pick, alive);
    }
  }

  async function intoCard(token, alive) {
    const entered = await tool('enter_card', { token });
    const parentKey = keyByCard.get(entered.briefing.parentId);
    const parent = parentKey?.endsWith('>') ? BY_KEY.get(parentKey.slice(0, -1)).followup : BY_KEY.get(parentKey);
    if (entered.kind === 'review') {
      const steps = ['Reading the submitted proof line by line; not looking at how the author got there.', 'Trying to break it: checking each inference, hidden assumptions and whether the claim matches the goal.', 'Designing a check the user can run without trusting any of this research.'];
      for (const text of steps) {
        await sleep(jitter(1800, 3000));
        if (!alive()) return;
        await tool('note', { token, text });
      }
      await sleep(jitter(1200, 2200));
      return void (await tool('submit_review', { token, ...parent.review }));
    }
    const key = `${parentKey}>`;
    cardByKey.set(key, entered.cardId);
    keyByCard.set(entered.cardId, key);
    return work(token, key, parent.followup, alive);
  }

  return function spawnAgent({ agent, role }) {
    let killed = false;
    const alive = () => !killed;
    const n = role === 'researcher' ? researchers++ : 0;
    const run = role === 'researcher' ? researcher(agent.token, n, alive) : intoCard(agent.token, alive);
    return {
      exited: run.then(
        () => ({ code: 0 }),
        (err) => (killed || ['gone', 'finished'].includes(err.code) ? { code: 0 } : { code: 1, error: err.message }),
      ),
      kill() {
        killed = true;
      },
    };
  };
}
