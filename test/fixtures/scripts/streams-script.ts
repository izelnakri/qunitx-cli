// Interleaves a slow-to-serialize argument with plain strings. The object needs a bigger CDP
// round-trip than the lines after it, so unordered writes would let those lines overtake it.
console.log({ rows: Array.from({ length: 400 }, (_, index) => ({ index, pad: 'x'.repeat(16) })) });

for (let index = 0; index < 12; index++) {
  console.log('line', index);
}

console.warn('a warning');
console.error('an error');
