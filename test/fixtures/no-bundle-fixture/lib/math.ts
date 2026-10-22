// An enum is not erasable syntax: this file goes through the full transform, with a source map.
export enum Operation {
  Add,
  Multiply,
}

export function apply(operation: Operation, left: number, right: number): number {
  return operation === Operation.Add ? left + right : left * right;
}
