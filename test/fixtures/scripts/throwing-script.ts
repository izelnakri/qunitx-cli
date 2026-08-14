// Throws from a named function so the mapped stack has a frame worth asserting on.
console.log('before the throw');

function detonate(): never {
  throw new Error('script blew up');
}

detonate();
