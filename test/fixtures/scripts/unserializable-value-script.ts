// A default export JSON cannot carry, nested one level down so the failure has to name the path
// rather than just the whole value.
export default { ok: true, index: new Map([['ada', 1]]) };
