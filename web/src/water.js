// Placeholder water: one flat fill under everything. Task 5's floor replaces it.
export const WATER = '#6fb3b8';

export function draw(ctx, state) {
  ctx.fillStyle = WATER;
  ctx.fillRect(0, 0, state.view.pondWidth, state.view.pondHeight);
}
