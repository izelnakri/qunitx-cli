// A plain script — no QUnit imports, no test registrations. Exercises what `qunitx run` promises
// a script it runs in the browser: top-level await, a DOM, and a real http:// origin.
const label: string = await Promise.resolve('top-level await');

document.body.innerHTML = '<h1 id="heading">rendered</h1>';

console.log('label:', label);
console.log('dom:', document.getElementById('heading')?.textContent);
console.log('origin:', location.origin.startsWith('http://localhost'));
console.log('meta:', typeof import.meta.url);
