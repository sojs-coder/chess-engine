/**
 * Genetic algorithm that evolves the evaluation weights used by strength().
 *
 * A chromosome is a 5-element array [material, mobility, pawnAdvancement,
 * threats, hanging] normalised so elements are ≥ 0 and sum to 1.
 *
 * Fitness is measured via self-play using CONTINUOUS scoring (position
 * evaluation differential, not binary win/loss). This is critical: a binary
 * {-1,0,+1} score saturates immediately when all individuals beat a weak
 * baseline — giving everyone the same fitness and stalling the GA. A continuous
 * score preserves gradient information even when one side dominates.
 *
 * By default, individuals compete HEAD-TO-HEAD against random peers from the
 * current population (co-evolutionary fitness). This makes fitness relative,
 * so selection pressure is maintained even when all individuals are "good".
 * A fixed baseline can be supplied if an absolute reference is preferred, but
 * the baseline must be competitive or the signal collapses.
 *
 * GA operators:
 *   Selection  — binary tournament (two random individuals, winner advances)
 *   Crossover  — uniform (each gene independently chosen from one parent)
 *   Mutation   — Gaussian perturbation, clamped ≥ 0 then re-normalised
 *   Elitism    — top-N individuals carried forward unchanged
 */

import { Board } from './Board';
import { Color, Move } from './types';
import { Weights, evaluateStatic, strength } from './Strength';

// ---------------------------------------------------------------------------
// Chromosome helpers
// ---------------------------------------------------------------------------

type Chromosome = [number, number, number, number, number];
//                 material  mobility  pawnAdv  threats  hanging

function toWeights(c: Chromosome): Weights {
  return {
    material:        c[0],
    mobility:        c[1],
    pawnAdvancement: c[2],
    threats:         c[3],
    hanging:         c[4],
  };
}

function normalize(c: Chromosome): Chromosome {
  const abs = c.map(x => Math.max(0, x));
  const sum = abs.reduce((s, x) => s + x, 0);
  if (sum === 0) return [0.2, 0.2, 0.2, 0.2, 0.2];
  return abs.map(x => x / sum) as Chromosome;
}

function randomChromosome(): Chromosome {
  return normalize([
    Math.random(), Math.random(), Math.random(), Math.random(), Math.random(),
  ]);
}

// ---------------------------------------------------------------------------
// Move selection used inside game simulation
// ---------------------------------------------------------------------------

function allMoves(board: Board): Move[] {
  const moves: Move[] = [];
  for (let rank = 0; rank < 8; rank++)
    for (let file = 0; file < 8; file++)
      moves.push(...board.getLegalMoves({ file, rank }));
  return moves;
}

/**
 * Pick the move that maximises the evaluation for `color` using `weights`.
 * Uses `evalPly` extra plies of lookahead (0 = purely static, 1 or 2 = mini search).
 */
function pickBestMove(
  board: Board,
  color: Color,
  weights: Weights,
  evalPly: 0 | 1 | 2
): Move | null {
  const moves = allMoves(board);
  if (moves.length === 0) return null;

  let bestMove = moves[0];
  let bestScore = -Infinity;

  for (const m of moves) {
    if (!board.makeMove(m)) continue;
    const score = strength(board, color, weights, evalPly);
    board.undoMove();
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }

  return bestMove;
}

// ---------------------------------------------------------------------------
// Game simulation — continuous scoring
// ---------------------------------------------------------------------------

/**
 * Play one game with `whiteWeights` driving White and `blackWeights` driving
 * Black. Returns a CONTINUOUS score from White's perspective.
 *
 * Checkmate: ±(1 + remainingFraction) so faster mates score higher than slow
 * ones — this prevents the GA from being indifferent between a 5-move win and
 * a 60-move win.
 *
 * Truncation: returns the raw static position evaluation, which is already
 * continuous in [-1, 1].
 *
 * This replaces the old {-1, 0, +1} scheme. Binary outcomes create a fitness
 * ceiling: once every individual beats the opponent, all fitnesses are identical
 * and selection pressure collapses.
 */
function playGame(
  whiteWeights: Weights,
  blackWeights: Weights,
  maxHalfMoves: number,
  evalPly: 0 | 1 | 2
): number {
  const board = new Board();

  for (let ply = 0; ply < maxHalfMoves; ply++) {
    if (board.isCheckmate()) {
      // Faster mate → larger magnitude score
      const urgency = 1 + (maxHalfMoves - ply) / maxHalfMoves;
      return board.getActiveColor() === Color.White ? -urgency : urgency;
    }
    if (board.isStalemate()) return 0;

    const color   = board.getActiveColor();
    const weights = color === Color.White ? whiteWeights : blackWeights;

    const move = pickBestMove(board, color, weights, evalPly);
    if (!move || !board.makeMove(move)) return 0;
  }

  // Truncated — use static position eval (continuous, no threshold)
  return evaluateStatic(board, Color.White, whiteWeights);
}

// ---------------------------------------------------------------------------
// Genetic optimizer
// ---------------------------------------------------------------------------

export interface GeneticOptions {
  /** Number of individuals in each generation. Default 20. */
  populationSize?: number;
  /** Standard deviation for Gaussian mutation. Default 0.05. */
  mutationSigma?: number;
  /** Per-gene mutation probability. Default 0.2. */
  mutationRate?: number;
  /** Number of top individuals carried forward unchanged. Default 2. */
  eliteCount?: number;
  /**
   * Number of opponents each individual plays per fitness evaluation.
   * Each matchup is played twice (once per colour) for balance.
   * More opponents = more stable fitness estimate, but slower. Default 4.
   */
  opponents?: number;
  /** Maximum half-moves per game before truncation. Default 60. */
  maxHalfMoves?: number;
  /**
   * Lookahead plies for move selection inside game simulation.
   * 0 = static eval only (fast), 1–2 = mini search (stronger, slower).
   * Default 0.
   */
  evalPly?: 0 | 1 | 2;
  /**
   * Fixed opponent weights used to measure fitness.
   * Defaults to `null` (head-to-head: each individual plays random peers
   * from the current population). Head-to-head is strongly recommended —
   * a fixed baseline creates a fitness ceiling the moment all individuals
   * beat it, stalling the GA entirely.
   *
   * Only pass explicit weights here if you want to measure improvement
   * against a specific known benchmark.
   */
  baselineWeights?: Weights | null;
}

export class GeneticOptimizer {
  private population: Chromosome[];
  private readonly opts: Required<GeneticOptions>;

  constructor(options: GeneticOptions = {}) {
    this.opts = {
      populationSize:  options.populationSize ?? 20,
      mutationSigma:   options.mutationSigma  ?? 0.05,
      mutationRate:    options.mutationRate   ?? 0.20,
      eliteCount:      options.eliteCount     ?? 2,
      opponents:       options.opponents      ?? 4,
      maxHalfMoves:    options.maxHalfMoves   ?? 60,
      evalPly:         options.evalPly        ?? 0,
      // Default null = head-to-head. Explicit baseline risks ceiling saturation.
      baselineWeights: options.baselineWeights !== undefined
        ? options.baselineWeights
        : null,
    };

    this.population = Array.from({ length: this.opts.populationSize }, randomChromosome);
  }

  // ---- Fitness (continuous, head-to-head by default) ----------------------

  /**
   * Compute fitness for every individual in the current population at once.
   *
   * Head-to-head mode: each individual plays `opponents` randomly chosen peers.
   * Computing all at once lets us pick opponents from the full population rather
   * than the half that has been evaluated so far.
   *
   * Fixed-baseline mode: each individual plays the provided weights.
   */
  private computeFitnesses(): number[] {
    const { opponents, maxHalfMoves, evalPly, baselineWeights } = this.opts;
    const n = this.population.length;
    const scores = new Array<number>(n).fill(0);

    for (let i = 0; i < n; i++) {
      const candidate = toWeights(normalize(this.population[i]));

      for (let k = 0; k < opponents; k++) {
        let opp: Weights;
        if (baselineWeights !== null) {
          opp = baselineWeights;
        } else {
          // Pick a random peer that isn't the individual itself
          let j = Math.floor(Math.random() * (n - 1));
          if (j >= i) j++;
          opp = toWeights(normalize(this.population[j]));
        }

        // Play both colours; net score cancels first-move advantage
        const asWhite = playGame(candidate, opp, maxHalfMoves, evalPly);
        const asBlack = playGame(opp, candidate, maxHalfMoves, evalPly);
        scores[i] += asWhite - asBlack; // positive = candidate did better
      }

      scores[i] /= opponents * 2; // normalise to roughly [-2, 2]
    }

    return scores;
  }

  // ---- GA operators -------------------------------------------------------

  /** Binary tournament selection — returns the index of the winner. */
  private select(fitnesses: number[]): number {
    const a = Math.floor(Math.random() * fitnesses.length);
    const b = Math.floor(Math.random() * fitnesses.length);
    return fitnesses[a] >= fitnesses[b] ? a : b;
  }

  /** Uniform crossover: each gene chosen independently from one parent. */
  private crossover(a: Chromosome, b: Chromosome): Chromosome {
    return a.map((g, i) => Math.random() < 0.5 ? g : b[i]) as Chromosome;
  }

  /** Gaussian mutation with per-gene probability, then re-normalise. */
  private mutate(c: Chromosome): Chromosome {
    const { mutationRate, mutationSigma } = this.opts;
    return normalize(
      c.map(g => Math.random() < mutationRate ? g + boxMuller() * mutationSigma : g) as Chromosome
    );
  }

  // ---- Main loop ----------------------------------------------------------

  /**
   * Run the genetic algorithm for `generations` generations.
   *
   * @param generations    Number of generations. Default 20.
   * @param onGeneration   Progress callback `(gen, bestWeights, bestScore, avgScore)`.
   *                       In head-to-head mode scores are relative (not absolute).
   * @returns The best Weights found after all generations.
   */
  evolve(
    generations = 20,
    onGeneration?: (gen: number, best: Weights, bestScore: number, avgScore: number) => void
  ): Weights {
    for (let gen = 0; gen < generations; gen++) {
      const fitnesses = this.computeFitnesses();

      const ranked = this.population
        .map((c, i) => ({ c, f: fitnesses[i] }))
        .sort((a, b) => b.f - a.f);

      const avg = fitnesses.reduce((s, f) => s + f, 0) / fitnesses.length;
      onGeneration?.(gen + 1, toWeights(ranked[0].c), ranked[0].f, avg);

      const next: Chromosome[] = [];

      // Elitism — carry the best individuals forward unchanged
      for (let i = 0; i < this.opts.eliteCount; i++) next.push(ranked[i].c);

      // Fill remaining slots: select → crossover → mutate
      while (next.length < this.opts.populationSize) {
        const pa = this.population[this.select(fitnesses)];
        const pb = this.population[this.select(fitnesses)];
        next.push(this.mutate(this.crossover(pa, pb)));
      }

      this.population = next;
    }

    return this.getBestWeights();
  }

  /**
   * Run one final fitness evaluation and return the best individual as Weights.
   */
  getBestWeights(): Weights {
    const fitnesses = this.computeFitnesses();
    const bestIdx   = fitnesses.indexOf(Math.max(...fitnesses));
    return toWeights(normalize(this.population[bestIdx]));
  }
}

// ---------------------------------------------------------------------------
// Box-Muller transform: sample from the standard normal distribution
// ---------------------------------------------------------------------------

function boxMuller(): number {
  const u = 1 - Math.random(); // avoid log(0)
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}




const refinedWeights = {
    material: 0.32, mobility: 0.26, pawnAdvancement: 0.33,
    threats: 0.07, hanging: 0.02
  };
  const ga = new GeneticOptimizer({
    // baselineWeights: refinedWeights,
    // mutationSigma: 0.02,
    opponents: 8,
  });
  ga.evolve(30, (gen, w, best, avg) =>
    console.log(`Gen ${gen}: best=${best.toFixed(3)} avg=${avg.toFixed(3)}`, w)
  );