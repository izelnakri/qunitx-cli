// A default export JSON cannot carry, nested one level down so the report has to name the path
// rather than just the whole value. The run itself is fine; only the value stays behind.
export default { ok: true, index: new Map([['ada', 1]]) };
