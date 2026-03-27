/**
 * Returns `portNumber` if it is free, otherwise recursively tries `portNumber + 1` until a free port is found.
 * @returns {Promise<number>}
 */
export default async function resolvePortNumberFor(portNumber: number): Promise<number> {
  if (await portIsAvailable(portNumber)) {
    return portNumber;
  }

  return await resolvePortNumberFor(portNumber + 1);
}

async function portIsAvailable(portNumber: number): Promise<boolean> {
  const net = await import('net');
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', function (_err) {
      resolve(false);
    });

    server.once('listening', function () {
      server.close();
      resolve(true);
    });

    server.listen(portNumber);
  });
}
