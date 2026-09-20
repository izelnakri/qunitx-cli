// A `debugger` inside a real file, so a pause has a source location to name rather than the
// `<anonymous>` a typed-in function gets.
export function inspectMe(): number {
  const answer = 42;
  debugger;

  return answer;
}
