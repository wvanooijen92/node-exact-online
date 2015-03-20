'use-strict';

/** Dependencies */
var querystring = require('querystring'),
    url = require('url'),
    https = require('https'),
    _ = require('lodash');

/**
 * Client
 * @param  {Object} options  Options object
 * @return {Client}          Returns itself
 */
var Client = function(options) {
  var defaults = {
    clientId: null,
    env: 'production',
    debug: false,
    redirectUri: null
  };

  this.options = _.merge({}, defaults, options);

  this.oauth = {
    requestCode: null,
    authorized: false,
    expires: null,
    token: {},
    refreshToken: null
  };

  this.apiUrl = 'start.exactonline.nl';

  return this;
};

/**
 * Client constuctor
 * @param  {Object} options  Options object
 * @return {Client}          Returns a new instance of the Client object
 */
module.exports.createClient = function(options) {
  return new Client(options);
};


Client.prototype.sendRequest = function(endpoint, method, params, data, callback) {
  var requiresAuth = !(endpoint === '/oauth2/token'),
      self = this,
      body;

  // Check arguments
  if(typeof params === 'function') {
    callback = params;
  } else if(typeof data === 'function') {
    callback = data;
  }

  // if a (POST) data object is passed, stringify it
  if(typeof data === 'object') {
    body = querystring.stringify(data);
  }

  // Set headers
  var headers = {
    'Cache-Control': 'no-cache',
    'Accept': 'application/json',
  };

  // If this is a POST, set appropriate headers
  if(method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = body.length;
  }

  // Wrap the request in a function
  var doRequest = function() {

    if(self.options.debug) {
      console.log('Making request to endpoing: "'+ endpoint +'"');
      if(requiresAuth) {
        console.log('Request requires authentication');
      }
    }  

    // Set request options
    var options = {
      host: self.apiUrl,
      port: 443,
      method: method,
      headers: headers
    };

    // Stringify URL params
    var paramString = querystring.stringify(params);

    // Check if the params object exists and is not empty
    if(typeof params === 'object' && paramString !== '') { 
      // If exists and not empty, add them to the endpoint
      options.path = ['/api' + endpoint, '?', paramString].join('');
    } else {
      options.path = '/api' + endpoint;
    }

    // Make the request
    var req = https.request(options, function(res) {
      var responseData = '';

      // Set the response to utf-8 encoding
      res.setEncoding('utf-8');

      // Add chunk to responseData
      res.on('data', function (chunk) {
        responseData += chunk;
      });

      // Request ended, wrap up
      res.on('end', function () {
        try {
          responseData = JSON.parse(responseData);
        } catch (e) {
          // Don't parse responseData
          console.log(responseData);
        }
        callback(null, responseData);
      });
    });

    // Handle API errors
    req.on('error', function(err, data) {

      console.log(req);

      callback(err, data);
    });

    // Write request body
    if(options.method === 'POST') {
      req.write(body);
    }

    // End request
    req.end();       
  };

  // Check if this request needs authorization
  if(requiresAuth) {

    // Authorization is required, check if auth is valid
    self.checkAuth(function(err, isValid, token) {

      if(isValid) {

        // Set authorization header
        headers['Authorization'] = 'Bearer ' + token.access_token;

        // Make the request
        doRequest();


      } else {

        // Auth is not valid, return a custom error
        callback(new Error('No valid authentication found, please set either a token request code, or a valid refresh token'), null);

      }

    });

  } else {
    // No authorization is required, just make the request
    doRequest();
  }


};

/**
 * Checks the client for valid authentication
 * Generates a new token if needed and possible
 * @param  {Function} cb calllback
 */
Client.prototype.checkAuth = function(cb) {

  if(this.options.debug) {
    console.log('Checking auth');
  }  

  // Check if the client is authorized
  if(this.oauth.authorized && this.oauth.expires > Date.now()) {
    
    if(this.options.debug) {
      console.log('Client is authorized and token is still valid');
    }  

    // Client is authorized and token is still valid
    cb(null, true, this.oauth.token);

  } else if((this.oauth.authorized && this.oauth.expires < Date.now()) || (!this.oauth.authorized && this.oauth.refreshToken)) {
    
    if(this.options.debug) {
      console.log('Either the token has expired, or the client is not authorized but has a refresh token');
    }  
    // Either the token has expired, or the client is not authorized but has a refresh token
    // With this info a new token can be requested
    this.refreshToken(function(err, token) {
      cb(err, true, token);
    });

  } else if(this.oauth.requestCode) {

    if(this.options.debug) {
      console.log('No token or refresh token exists, but a request code does');
    }  

    // If no token or refresh token exists, but a request code does, authorize the client
    this.authorize(this.oauth.requestToken, function(err, token) {
      cb(err, true, token);
    });

  } else {

    if(this.options.debug) {
      console.log('No token, refresh token or request code found, this client is in no way authenticated');
    }  

    // No token, refresh token or request code found, this client is in no way authenticated
    cb(null, false, null);
  }



};

/**
 * Get auth URL
 * @param {String} [redirectUri] Redirect URI
 * @param {String} [responseType] Response Type
 * @return {String} Authentication URL
 */
Client.prototype.authUrl = function(redirectUri, responseType) {
  var authUrl = url.resolve('https://' + this.apiUrl, '/api/oauth2/auth');

  authUrl += '?' + querystring.unescape(querystring.stringify({
    'response_type': responseType || 'code',
    'client_id': this.options.clientId,
    'redirect_uri': redirectUri,
  }));

  return authUrl;
};


/**
 * Get oauth token
 * @param {Function} callback Gets called after request is complete
 */
Client.prototype.token = function(code, grantType, redirectUri, callback) {
  var data = {
    grant_type: grantType,
    client_id: this.options.clientId,
    client_secret:this.options.clientSecret,
  } 

  switch(grantType) {
    case 'authorization_code':
      data.code = code;
      data.redirect_uri = redirectUri;
      data.force_login = 0;
      break;

    case 'refresh_token':
      data.refresh_token = code;
      break;
  }

  this.sendRequest('/oauth2/token', 'POST', {}, data, callback);
};

/**
 * Authorizes the client
 * @param {Function} callback Gets called after request is complete
 */
Client.prototype.authorize = function(code, callback) {
  var self = this;

  if(this.options.debug) {
    console.log('Retreiving access token with code: "'+ code + '"');
  }

  this.token(code, 'authorization_code', this.options.redirectUri, function(err, token) {

    if(self.options.debug) {
      console.log('Retreived token: ' + JSON.stringify(token));
    }

    self.oauth.authorized = true;
    self.oauth.token = token;
    self.oauth.refreshToken = token.refresh_token;
    self.oauth.expires = Date.now() + (parseInt(token.expires_in) * 1000);

    callback(err, token.refresh_token);
  });

};

/**
 * Refreshes the client token
 * @param {Function} callback Gets called after request is complete
 */
Client.prototype.refreshToken = function(callback) {
  var self = this;

  if(this.options.debug) {
    console.log('Refreshing token with refresh_token: "'+ this.oauth.refreshToken + '"');
  }

  this.token(this.oauth.refreshToken, 'refresh_token', this.options.redirectUri, function(err, token) {
    if(self.options.debug) {
      console.log('Retreived token: ' + JSON.stringify(token));
    }

    self.oauth.authorized = true;
    self.oauth.token = token;
    self.oauth.refreshToken = token.refresh_token;
    self.oauth.expires = Date.now() + (parseInt(token.expires_in) * 1000);

    callback(err, token);
  });

};





/**
 * Get oauth token
 * @param {Function} callback Gets called after request is complete
 */
Client.prototype.me = function(callback) {
  this.sendRequest('/v1/current/Me', 'GET', null, null, callback);
};