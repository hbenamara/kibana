import Promise from 'bluebird';
import sinon from 'sinon';
import expect from 'expect.js';
import url from 'url';

const NoConnections = require('elasticsearch').errors.NoConnections;

import healthCheck from '../health_check';
import kibanaVersion from '../kibana_version';
import serverConfig from '../../../../../test/server_config';

const esPort = serverConfig.servers.elasticsearch.port;
const esUrl = url.format(serverConfig.servers.elasticsearch);

describe('plugins/elasticsearch', () => {
  describe('lib/health_check', () => {
    let health;
    let plugin;
    let client;

    beforeEach(() => {
      const COMPATIBLE_VERSION_NUMBER = '5.0.0';

      // Stub the Kibana version instead of drawing from package.json.
      sinon.stub(kibanaVersion, 'get').returns(COMPATIBLE_VERSION_NUMBER);

      // setup the plugin stub
      plugin = {
        name: 'elasticsearch',
        status: {
          red: sinon.stub(),
          green: sinon.stub(),
          yellow: sinon.stub()
        }
      };

      // set up the elasticsearch client stub
      client = {
        cluster: { health: sinon.stub() },
        indices: { create: sinon.stub() },
        nodes: { info: sinon.stub() },
        ping: sinon.stub(),
        create: sinon.stub(),
        index: sinon.stub().returns(Promise.resolve()),
        get: sinon.stub().returns(Promise.resolve({ found: false })),
        search: sinon.stub().returns(Promise.resolve({ hits: { hits: [] } })),
      };

      client.nodes.info.returns(Promise.resolve({
        nodes: {
          'node-01': {
            version: COMPATIBLE_VERSION_NUMBER,
            http_address: `inet[/127.0.0.1:${esPort}]`,
            ip: '127.0.0.1'
          }
        }
      }));

      // setup the config().get()/.set() stubs
      const get = sinon.stub();
      get.withArgs('elasticsearch.url').returns(esUrl);
      get.withArgs('kibana.index').returns('.my-kibana');

      const set = sinon.stub();

      // Setup the server mock
      const server = {
        log: sinon.stub(),
        info: { port: 5601 },
        config: function () { return { get, set }; },
        plugins: { elasticsearch: { client  } }
      };

      health = healthCheck(plugin, server);
    });

    afterEach(() => {
      kibanaVersion.get.restore();
    });

    it('should set the cluster green if everything is ready', function () {
      client.ping.returns(Promise.resolve());
      client.cluster.health.returns(Promise.resolve({ timed_out: false, status: 'green' }));
      return health.run()
        .then(function () {
          sinon.assert.calledOnce(plugin.status.yellow);
          expect(plugin.status.yellow.args[0][0]).to.be('Waiting for Elasticsearch');
          sinon.assert.calledOnce(client.ping);
          sinon.assert.calledOnce(client.nodes.info);
          sinon.assert.calledOnce(client.cluster.health);
          sinon.assert.calledOnce(plugin.status.green);
          expect(plugin.status.green.args[0][0]).to.be('Kibana index ready');
        });
    });

    it('should set the cluster red if the ping fails, then to green', function () {
      client.ping.onCall(0).returns(Promise.reject(new NoConnections()));
      client.ping.onCall(1).returns(Promise.resolve());
      client.cluster.health.returns(Promise.resolve({ timed_out: false, status: 'green' }));
      return health.run()
        .then(function () {
          sinon.assert.calledOnce(plugin.status.yellow);
          expect(plugin.status.yellow.args[0][0]).to.be('Waiting for Elasticsearch');
          sinon.assert.calledOnce(plugin.status.red);
          expect(plugin.status.red.args[0][0]).to.be(
            `Unable to connect to Elasticsearch at ${esUrl}.`
          );
          sinon.assert.calledTwice(client.ping);
          sinon.assert.calledOnce(client.nodes.info);
          sinon.assert.calledOnce(client.cluster.health);
          sinon.assert.calledOnce(plugin.status.green);
          expect(plugin.status.green.args[0][0]).to.be('Kibana index ready');
        });
    });

    it('should set the cluster red if the health check status is red, then to green', function () {
      client.ping.returns(Promise.resolve());
      client.cluster.health.onCall(0).returns(Promise.resolve({ timed_out: false, status: 'red' }));
      client.cluster.health.onCall(1).returns(Promise.resolve({ timed_out: false, status: 'green' }));
      return health.run()
        .then(function () {
          sinon.assert.calledOnce(plugin.status.yellow);
          expect(plugin.status.yellow.args[0][0]).to.be('Waiting for Elasticsearch');
          sinon.assert.calledOnce(plugin.status.red);
          expect(plugin.status.red.args[0][0]).to.be(
            'Elasticsearch is still initializing the kibana index.'
          );
          sinon.assert.calledOnce(client.ping);
          sinon.assert.calledOnce(client.nodes.info);
          sinon.assert.calledTwice(client.cluster.health);
          sinon.assert.calledOnce(plugin.status.green);
          expect(plugin.status.green.args[0][0]).to.be('Kibana index ready');
        });
    });

    it('should set the cluster yellow if the health check timed_out and create index', function () {
      client.ping.returns(Promise.resolve());
      client.cluster.health.onCall(0).returns(Promise.resolve({ timed_out: true, status: 'red' }));
      client.cluster.health.onCall(1).returns(Promise.resolve({ timed_out: false, status: 'green' }));
      client.indices.create.returns(Promise.resolve());
      return health.run()
        .then(function () {
          sinon.assert.calledTwice(plugin.status.yellow);
          expect(plugin.status.yellow.args[0][0]).to.be('Waiting for Elasticsearch');
          expect(plugin.status.yellow.args[1][0]).to.be('No existing Kibana index found');
          sinon.assert.calledOnce(client.ping);
          sinon.assert.calledOnce(client.indices.create);
          sinon.assert.calledOnce(client.nodes.info);
          sinon.assert.calledTwice(client.cluster.health);
        });
    });

    describe('#waitUntilReady', function () {
      it('polls health until index is ready', function () {
        client.cluster.health.onCall(0).returns(Promise.resolve({ timed_out: true })); // no index
        client.cluster.health.onCall(1).returns(Promise.resolve({ status: 'red' }));   // initializing
        client.cluster.health.onCall(2).returns(Promise.resolve({ status: 'green' })); // ready

        return health.waitUntilReady().then(function () {
          sinon.assert.calledThrice(client.cluster.health);
        });
      });
    });
  });
});
