'use strict';
/**
 * Kong API wrapper. These methods will call out to the Kong API
 * to do a variety of things.
 */
const _ = require('lodash');
const debug = require('debug')('ohio::kosso::kong');

/**
 * Instantiate an instance of the Kong API wrapper.
 *
 * TODO: Support provision keys per-api.
 */
function Kong(api, gateway, provisionKey) {
    this.api = api;
    this.gateway = gateway;
    this.request = require('request');
    this.provisionKey = provisionKey;
}

Kong.prototype = {
    /**
     * Set whether or not SSL certificates on the API and Gateway
     * should be validated.
     *
     * @param {boolean} value True or false.
     */
    setValidateCertificates: function (value) {
        if (value) {
            this.request = require('request');
        } else {
            this.request = require('request').defaults({
                strictSSL: false
            });
        }
    },

    /**
     * Get details about the specified client from Kong.
     *
     * @param {string} clientId The client ID.
     */    
    getClient: function (clientId) {
        var self = this;

        return new Promise(function (resolve, reject) {
            self.request.get(`${self.api}/oauth2`, {
                qs: {
                    client_id: clientId
                }
            }, function (error, response, body) {
                if (!_.isNil(error)) {
                    debug(`Error fetching client information for ${clientId} from Kong.`, error);
                    return reject({ status: 500, details: error });
                }

                // We want to try to map responses from Kong to something sane. If it's
                // an internal server error, throw it.
                if (response.statusCode >= 500) {
                    return reject({ status: response.statuscode, details: body });
                } else if (response.statusCode >= 400) {
                    // Any 400 level error usually means bad input from the user, so send that.
                    return reject({ status: 400, details: `400 Bad Request. Upstream responded with ${response.statusCode} ${response.statusMessage}: ${body}` });
                }

                var json = JSON.parse(body);                
                debug('Got response from Kong: ', json);

                // Kong won't return a 404 for unknown clients but a list of 0 entries, make it a 404 instead.                
                if (json.total === 0) {
                    return reject({ status: 404, details: `404 Not Found. The client ${clientId} is unknown to API Gateway.` });
                } else if (json.total > 1) {
                    return reject({ status: 500, details: `500 Internal Server Error. There seem to be 2 clients with ID ${clientId}.` });
                } else {
                    return resolve(json.data[0]);
                }
            });
        });
    },

    /**
     * Provision an access token for the specified API, client, and user.
     *
     * @param {string} api              The API (host/url) for which we're generating a token.
     * @param {string} client           The client object from Kong that contains the client ID and secret.
     * @param {string} resposneType     The OAuth responseType sent by the user's client.
     * @param {string} scope            The OAuth scope sent by the user's client.
     * @param {string} user             The logged in user object returned from SSO.
     */    
    provision: function (api, client, responseType, scope, user) {
        var self = this;

        debug(`Provisioning new access token for ${user}@${client.client_id}.`);
        
        var data = {
            client_id: client.client_id,
            response_type: responseType,
            provision_key: this.provisionKey,
            authenticated_userid: user
        };

        if (!_.isNil(scope)) {
            data['scope'] = scope;
        }
        
        const apidef = api.split('/');

        return new Promise(function (resolve, reject) { 
            self.request.post(`${self.gateway}/${apidef.splice(1).join('/')}/oauth2/authorize`, {
                formData: data,
                auth: {
                    user: client.client_id,
                    pass: client.client_secret,
                    sendImmediately: true   // Kong doesn't send WWW-Authenticate properly for it's API so we
                                            // need to send the credentials with our first request.
                },
                headers: {
                    Host: apidef[0]     // We need to set the host here explicitly so we forward the API host the user went to.
                }
            }, function (error, response, body) { 
                if (!_.isNil(error)) {
                    debug(`Error provisining access token for ${user}@${client.client_id} to Kong.`, error);
                    return reject({ status: 500, details: error });
                }

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    debug('Successfully provisioned token with response:', body);
                    return resolve(JSON.parse(body));
                } else if (response.statusCode >= 400 && response.statusCode < 500) {
                    return reject({ status: 400, details: `400 Bad Request. Upstream responded with ${response.statusCode} ${response.statusMessage}: ${body}` });
                } else {
                    return reject({ status: response.statusCode, body });
                }
            });
        });
    }
};

module.exports = Kong;
