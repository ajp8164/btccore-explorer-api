'use strict';

var _ = require('lodash');
var async = require('async');
var request = require('request');

var rateSources = {
  'USD': {
    name: 'Bitstamp',
    url: 'https://www.bitstamp.net/api/v2/ticker/btcusd',
    path: 'last', // path to result
    unit: {
      name: 'US Dollar',
      shortName: 'USD',
      value: 0, // Fetched by client
      decimals: 2,
      code: 'USD',
      kind: 'fiat'
    }
  },
  'EUR': {
    name: 'Bitstamp',
    url: 'https://www.bitstamp.net/api/v2/ticker/btceur',
    path: 'last', // path to result
    unit: {
      name: 'Euro',
      shortName: 'EUR',
      value: 0, // Fetched by client
      decimals: 2,
      code: 'EUR',
      kind: 'fiat'
    }
  }
};

function CurrencyController(options) {
  this.node = options.node;
  var refresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;
  this.currencyDelay = refresh * 60000;
  this.rates = {};
  this.timestamp = Date.now();
}

CurrencyController.DEFAULT_CURRENCY_DELAY = 10;

CurrencyController.prototype.index = function(req, res) {
  var self = this;
  var currentTime = Date.now();

  if (_.isEmpty(self.rates) || currentTime >= (self.timestamp + self.currencyDelay)) {
    self.timestamp = currentTime;

    async.eachSeries(Object.keys(rateSources), function(key, callback) {
      request(rateSources[key].url, function(err, response, body) {
        if (err) {
          self.node.log.error(err);
        }
        if (!err && response.statusCode === 200) {
          // Use the result path for source to read the response value.
          self.rates[key] = {
            name: rateSources[key].name,
            rate: parseFloat(_.get(JSON.parse(body), rateSources[key].path))
          };
        }
        callback();
      });

    }, function(err) {
      res.jsonp({
        status: 200,
        data: { 
          rates: self.rates
        }
      });
    });

  } else {
    res.jsonp({
      status: 200,
      data: { 
        rates: self.rates
      }
    });
  }

};

CurrencyController.getUnits = function() {
  return _.map(Object.keys(rateSources), function(k) {
    return rateSources[k].unit;
  });
};

module.exports = CurrencyController;
