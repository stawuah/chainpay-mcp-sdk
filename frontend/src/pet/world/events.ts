import type { MoveReason } from "./tttEngine";

// What a game tells the world, so Bam Bam can react. Every one of these is a
// reply to something the player did, never a volunteered line (R5, B22).
export type WorldEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "look"; x: number; y: number }
  // Snake
  | { type: "eat"; eaten: number }
  | { type: "best"; score: number }
  | { type: "crash"; cause: "wall" | "tail"; best: boolean }
  // Tic-tac-toe
  | { type: "opens" }
  | { type: "you"; cell: number }
  | { type: "think"; cells: number[]; ms: number }
  | { type: "place"; reason: MoveReason }
  | { type: "win" }
  | { type: "lose" }
  | { type: "draw"; spicy?: boolean };
