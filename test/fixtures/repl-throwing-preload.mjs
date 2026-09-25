// A preload whose top level throws, for the failed-start test.
export const never = 1;
throw new Error('this preload explodes on purpose');
