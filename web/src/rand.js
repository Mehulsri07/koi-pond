// Seeded randomness for the pond's art, so a seed always draws the same pond.
//
//   const random = createRandom(seed);   // a SplitMix32 stream
//   random()            // [0, 1)
//   random.range(a, b)  // [a, b)
//   random.int(a, b)    // an integer in [a, b]
//   random.chance(p)    // true with probability p
//   random.pick(list)   // one item
//   hash2(x, y, seed)   // a stateless [0, 1) value per integer lattice point
//   seedOf(value, salt) // a 32-bit seed from a non-negative safe integer and a salt
//   noise(x, y, cell, seed)  // smooth value noise in [0, 1) on a lattice of `cell` px
//
// SplitMix32 is the 32-bit form of SplitMix64: a Weyl sequence through a strong mixer.
// It is small, fast, and plenty for art; it is not for anything that must be secret.

function mix(z) {
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export function createRandom(seed) {
  let state = seed | 0;
  const random = () => {
    state = (state + 0x9e3779b9) | 0;
    return mix(state) / 4294967296;
  };
  random.range = (a, b) => a + (b - a) * random();
  random.int = (a, b) => a + Math.floor((b - a + 1) * random());
  random.chance = (p) => random() < p;
  random.pick = (list) => list[Math.floor(list.length * random())];
  return random;
}

export function hash2(x, y, seed) {
  return mix(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ mix(seed | 0)) / 4294967296;
}

export function seedOf(value, salt) {
  const id = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const low = id % 4294967296;
  const high = Math.floor(id / 4294967296);
  return mix(mix(low ^ Math.imul(high, 0x9e3779b9)) ^ mix(salt | 0));
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export function noise(x, y, cell, seed) {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = smooth(fx - ix);
  const ty = smooth(fy - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
