// Deliberately NO import and NO export anywhere, which is what makes esbuild compile this as
// CommonJS — the case where the module namespace's `default` is a synthesized `{}` rather than
// anything the script wrote. `result.value` has to be undefined all the same.
console.log('nothing exported');
