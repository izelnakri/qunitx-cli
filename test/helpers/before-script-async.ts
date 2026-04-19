import HTTPServer from '../../lib/servers/http.ts';
import { bindServerToPort } from '../../lib/setup/bind-server-to-port.ts';
import './before-script-basic.ts';
import QUnit from 'qunitx';

export default async function (config) {
  console.log('Starting before script with:');

  let hasServerRunning = !!config.webServer;

  config.webServer = config.webServer || new HTTPServer();
  config.webServer.get('/films', (req, res) => {
    console.log('req received');
    res.json({ film: 'responsed correctly' });
  });
  config.webServer.get('/movies/too-big-to-fail', (req, res) => {
    res.json({ movie: 'is too-big-to-fail' });
  });

  if (!hasServerRunning) {
    console.log('DOESNT HAVE SERVER RUNNING');
    let server = await bindServerToPort(config.webServer, config);

    QUnit.config.port = config.port;
    console.log(`Web server started on port ${QUnit.config.port}`);
  }
}
