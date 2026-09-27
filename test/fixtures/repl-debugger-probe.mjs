// A preload with a `debugger` in it, for the start-up deadlock regression test.
debugger;
export const reached = 'past the debugger';
