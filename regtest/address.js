'use strict';

var expect = require('chai').expect;
var spawn = require('child_process').spawn;
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var fs = require('fs');
var async = require('async');
var RPC = require('bitcoind-rpc');
var http = require('http');
var btccore = require('btccore-lib');
var PrivateKey = btccore.PrivateKey;
var Transaction = btccore.Transaction;

var rpc1Address;
var rpc2Address;
var blocksGenerated = 0;

var rpcConfig = {
  protocol: 'http',
  user: 'local',
  pass: 'localtest',
  host: '127.0.0.1',
  port: 58332,
  rejectUnauthorized: false
};

var rpc1 = new RPC(rpcConfig);
rpcConfig.port++;
var rpc2 = new RPC(rpcConfig);
var debug = true;
var btccoreDataDir = '/tmp/btccore';
var bitcoinDataDirs = ['/tmp/bitcoin1', '/tmp/bitcoin2'];

var bitcoin = {
  args: {
    datadir: null,
    listen: 1,
    regtest: 1,
    server: 1,
    rpcuser: 'local',
    rpcpassword: 'localtest',
    //printtoconsole: 1,
    rpcport: 58332,
  },
  datadir: null,
  exec: 'bitcoind', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/bitcoind
  processes: []
};

var btccore = {
  configFile: {
    file: btccoreDataDir + '/btccore-node.json',
    conf: {
      network: 'regtest',
      port: 53001,
      datadir: btccoreDataDir,
      services: [
        'p2p',
        'db',
        'header',
        'block',
        'address',
        'transaction',
        'mempool',
        'web',
        'insight-api',
        'fee',
        'timestamp'
      ],
      servicesConfig: {
        'p2p': {
          'peers': [
            { 'ip': { 'v4': '127.0.0.1' }, port: 18444 }
          ]
        },
        'insight-api': {
          'routePrefix': 'api'
        }
      }
    }
  },
  httpOpts: {
    protocol: 'http:',
    hostname: 'localhost',
    port: 53001,
  },
  opts: { cwd: btccoreDataDir },
  datadir: btccoreDataDir,
  exec: 'btccored',  //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/btccored
  args: ['start'],
  process: null
};

var request = function(httpOpts, callback) {

  var request = http.request(httpOpts, function(res) {

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      return callback('Error from btccore-node webserver: ' + res.statusCode);
    }

    var resError;
    var resData = '';

    res.on('error', function(e) {
      resError = e;
    });

    res.on('data', function(data) {
      resData += data;
    });

    res.on('end', function() {

      if (resError) {
        return callback(resError);
      }
      var data = JSON.parse(resData);
      callback(null, data);

    });

  });

  request.on('error', function(err) {
    callback(err);
  });

  if (httpOpts.body) {
    request.write(httpOpts.body);
  } else {
    request.write('');
  }
  request.end();
};

var waitForBlocksGenerated = function(callback) {

  var httpOpts = {
    hostname: 'localhost',
    port: 53001,
    path: '/api/status',
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  async.retry({ interval: 1000, times: 100 }, function(next) {

    request(httpOpts, function(err, data) {
      if (err) {
        return next(err);
      }
      if (data.info.blocks < blocksGenerated) {
        return next(data);
      }
      next();
    });

  }, callback);
};

var startBitcoind = function(count, callback) {

  var listenCount = 0;
  async.timesSeries(count, function(n, next) {

    var datadir = bitcoinDataDirs.shift();

    bitcoin.datadir = datadir;
    bitcoin.args.datadir = datadir;

    if (listenCount++ > 0) {
      bitcoin.args.listen = 0;
      bitcoin.args.rpcport++;
      bitcoin.args.connect = '127.0.0.1';
    }

    rimraf(datadir, function(err) {

      if(err) {
        return next(err);
      }

      mkdirp(datadir, function(err) {

        if(err) {
          return next(err);
        }

        var args = bitcoin.args;
        var argList = Object.keys(args).map(function(key) {
          return '-' + key + '=' + args[key];
        });

        var bitcoinProcess = spawn(bitcoin.exec, argList, bitcoin.opts);
        bitcoin.processes.push(bitcoinProcess);

        bitcoinProcess.stdout.on('data', function(data) {

          if (debug) {
            process.stdout.write(data.toString());
          }

        });

        bitcoinProcess.stderr.on('data', function(data) {

          if (debug) {
            process.stderr.write(data.toString());
          }

        });

        next();

      });

    });
  }, function(err) {

      if (err) {
        return callback(err);
      }

      var pids = bitcoin.processes.map(function(process) {
        return process.pid;
      });

      console.log(count + ' bitcoind\'s started at pid(s): ' + pids);

      async.retry({ interval: 1000, times: 1000 }, function(next) {
        rpc1.getInfo(function(err, res) {
          if (err) {
            return next(err);
          }
          // there is a bit of time even after the rpc server comes online that the rpc server is not truly ready
          setTimeout(function(err) {
            next();
          }, 1000);
        });
      }, callback);
  });
};


var shutdownBitcoind = function(callback) {
  bitcoin.processes.forEach(function(process) {
    process.kill();
  });
  setTimeout(callback, 3000);
};

var shutdownbtccore = function(callback) {
  if (btccore.process) {
    btccore.process.kill();
  }
  callback();
};

var txid;
var buildInitialChain = function(callback) {
  async.waterfall([
    function(next) {
      console.log('checking to see if bitcoind\'s are connected to each other.');
      rpc1.getInfo(function(err, res) {
        if (err || res.result.connections !== 1) {
          next(err || new Error('bitcoind\'s not connected to each other.'));
        }
        next();
      });
    },
    function(next) {
      console.log('generating 101 blocks');
      blocksGenerated += 101;
      rpc1.generate(101, next);
    },
    function(res, next) {
      console.log('getting new address from rpc2');
      rpc2.getNewAddress(function(err, res) {
        if (err) {
          return next(err);
        }
        rpc2Address = res.result;
        console.log(rpc2Address);
        next(null, rpc2Address);
      });
    },
    function(addr, next) {
      rpc1.sendToAddress(rpc2Address, 25, next);
    },
    function(res, next) {
      console.log('TXID: ' + res.result);
      console.log('generating 7 blocks');
      blocksGenerated += 7;
      rpc1.generate(7, next);
    },
    function(res, next) {
      rpc2.getBalance(function(err, res) {
        console.log(res);
        next();
      });
    },
    function(next) {
      console.log('getting new address from rpc1');
      rpc1.getNewAddress(function(err, res) {
        if (err) {
          return next(err);
        }
        rpc1Address = res.result;
        next(null, rpc1Address);
      });
    },
    function(addr, next) {
      rpc2.sendToAddress(rpc1Address, 20, next);
    },
    function(res, next) {
      txid = res.result;
      console.log('sending from rpc2Address TXID: ', res);
      console.log('generating 6 blocks');
      blocksGenerated += 6;
      rpc2.generate(6, next);
    }
  ], function(err) {

    if (err) {
      return callback(err);
    }
    rpc1.getInfo(function(err, res) {
      console.log(res);
      callback();
    });
  });

};

var startbtccore = function(callback) {

  rimraf(btccoreDataDir, function(err) {

    if(err) {
      return callback(err);
    }

    mkdirp(btccoreDataDir, function(err) {

      if(err) {
        return callback(err);
      }

      fs.writeFileSync(btccore.configFile.file, JSON.stringify(btccore.configFile.conf));

      var args = btccore.args;
      btccore.process = spawn(btccore.exec, args, btccore.opts);

      btccore.process.stdout.on('data', function(data) {

        if (debug) {
          process.stdout.write(data.toString());
        }

      });
      btccore.process.stderr.on('data', function(data) {

        if (debug) {
          process.stderr.write(data.toString());
        }

      });

      waitForBlocksGenerated(callback);
    });

  });

};

describe('Address', function() {

  this.timeout(60000);

  before(function(done) {

    async.series([
      function(next) {
        startBitcoind(2, next);
      },
      function(next) {
        buildInitialChain(next);
      },
      function(next) {
        startbtccore(next);
      }
    ], done);

  });

  after(function(done) {
    shutdownbtccore(function() {
      shutdownBitcoind(done);
    });
  });



  it('should get address info correctly: /addr/:addr', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/addr/' + rpc2Address,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.balance).to.equal(0);
      expect(data.totalSent).to.equal(25);
      done();

    });

  });

  it('should get a utxo: /addr/:addr/utxo', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/addr/' + rpc1Address + '/utxo',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.length).equal(1);
      expect(data[0].amount).equal(20);
      expect(data[0].satoshis).equal(2000000000);
      expect(data[0].confirmations).equal(6);
      done();

    });

  });

  it('should get multi-address utxos: /addrs/:addrs/utxo', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: 'http://localhost:53001/api/addrs/' + rpc2Address + ',' + rpc1Address + '/utxo',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.length).to.equal(1);
      expect(data[0].amount).to.equal(20);
      expect(data[0].satoshis).to.equal(2000000000);
      done();

    });

  });

  it('should post a utxo: /addrs/:addrs/utxo', function(done) {

    var body = JSON.stringify({
      addrs: [ rpc1Address, rpc2Address ]
    });

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addrs/utxo',
      method: 'POST',
      body: body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      },
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.length).to.equal(1);
      expect(data[0].amount).to.equal(20);
      expect(data[0].satoshis).to.equal(2000000000);
      done();

    });

  });

  it('should get txs for a set of addresses: /addrs/:addrs/txs', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addrs/' + rpc1Address + ',' + rpc2Address + '/txs',
      method: 'GET'
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.items.length).to.equal(3);
      expect(data.from).to.equal(0);
      expect(data.to).to.equal(3);
      done();

    });

  });

  it('should post txs for a set of addresses: /addrs/txs', function(done) {

    var body = JSON.stringify({
      addrs: [ rpc1Address, rpc2Address ]
    });

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addrs/txs',
      method: 'POST',
      body: body,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      console.log(data);
      expect(data.items.length).to.equal(3);
      expect(data.from).to.equal(0);
      expect(data.to).to.equal(3);
      done();

    });

  });

  it('should get totalReceived for an address: /addr/:addr/totalReceived', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addr/' + rpc1Address + '/totalReceived',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      var data = JSON.parse(data);
      expect(data).to.equal(2000000000);
      done();

    });

  });


  it('should get totalSent for an address: /addr/:addr/totalSent', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addr/' + rpc1Address + '/totalSent',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      var data = JSON.parse(data);
      expect(data).to.equal(0);
      done();
    });

  });

  it('should get unconfirmedBalance for an address: /addr/:addr/unconfirmedBalance', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addr/' + rpc1Address + '/unconfirmedBalance',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    request(httpOpts, function(err, data) {

      if(err) {
        return done(err);
      }

      var data = JSON.parse(data);
      expect(data).to.equal(0);
      done();
    });

  });

  it('should index addresses correctly', function(done) {
    // if we send a tx that has an address in both the input and the output, does it index correctly?
    var txid;
    var pk1;
    var tx;
    var utxo;

    async.waterfall([
      function(next) {
        rpc1.listUnspent(next);
      },
      function(res, next) {
        utxo = res.result[0];
        rpc1.dumpPrivKey(utxo.address, next);
      },
      function(res, next) {
        var pk = new PrivateKey(res.result);
        pk1 = new PrivateKey('testnet');
        var change = new PrivateKey('testnet');
        var changeAddress = change.toAddress();
        var from = {
          txId: utxo.txid,
          address: utxo.address,
          script: utxo.scriptPubKey,
          satoshis: utxo.amount * 1e8,
          outputIndex: utxo.vout
        };
        tx = new Transaction().from(from).to(pk1.toAddress(), 2500000000).change(changeAddress).sign(pk);
        rpc2.sendRawTransaction(tx.serialize(), next);
      },
      function(res, next) {
        txid = res.result;
        blocksGenerated += 1;
        rpc2.generate(1, next);
      },
      function(res, next) {
        var tx2 = new Transaction().from({
          txId: txid,
          satoshis: 2500000000,
          outputIndex: 0,
          script: tx.outputs[0].script.toHex(),
          address: pk1.toAddress()
        }).to(pk1.toAddress(), 2500000000 - 1000).sign(pk1);
        rpc2.sendRawTransaction(tx2.serialize(), next);
      },
      function(res, next) {
        txid = res.result;
        blocksGenerated += 1;
        rpc2.generate(1, next);
      },
      function(res, next) {
        waitForBlocksGenerated(next);
      },

    ], function(err) {

      if (err) {
        return done(err);
      }

      var httpOpts = {
        hostname: 'localhost',
        port: 53001,
        path: 'http://localhost:53001/api/addr/' + pk1.toAddress(),
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      };

      request(httpOpts, function(err, data) {

        if(err) {
          return done(err);
        }

        console.log(data);
        expect(data.transactions.length).to.equal(2);
        done();

      });
    });

  });
});