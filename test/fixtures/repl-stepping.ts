// A pause with somewhere to go: `step` enters `helper`, `next` runs it without entering, and
// `finish` runs out of whichever frame you are in.
export function helper(value: number): number {
  const doubled = value * 2;

  return doubled;
}

export function outer(): number {
  const start = 21;
  debugger;
  const answer = helper(start);

  return answer;
}
