'use strict';

const _ = require('lodash');
const config = require('./lib/config');
const passport = require('passport');
const express = require('express');
const utils = require('./lib/utils');
const fs = require('fs');
const path = require('path');
const debug = require('debug')('ohio::kosso::server');
const argv = require('yargs')
    .usage('Usage: $0')
    .alias('p', 'port')
    .nargs('p', 1)
    .default('p', config.get('server.port', 3000))
    .describe('p', 'Port on which to listen.')
    .alias('h', 'host')
    .nargs('h', 1)
    .default('h', config.get('server.host', '127.0.0.1'))
    .describe('h', 'Hostname on which to listen.')
    .alias('t', 'theme')
    .nargs('t', 1)
    .default('t', config.get('ui.theme', 'default'))
    .describe('t', 'Theme to use for views.').argv;

debug(`Using UI theme ${argv.theme}.`);

var authStrategies = {};
debug('Looking for available authentication strategies...');
fs.readdirSync('./lib/strategies').forEach(function (entry) {
    var name = path.basename(entry, 'js');

    if (name.lastIndexOf('.')) {
        name = name.slice(0, -1);
    }

    debug(`Plugging in strategy ${name}...`);
    authStrategies[name] = require(`./lib/strategies/${name}`);
    passport.use(name, authStrategies[name].strategy);
});

var app = express();

app.engine('hbs', require('express-handlebars')());
app.set('view engine', 'hbs');
app.set('views', `${__dirname}/views/${argv.theme}`);

const strategy = config.get('authentication.strategy');
var kong = new (require('./lib/kong'))(config.get('kong.api'), config.get('kong.gateway'), config.get('kong.provisionKey'));

if (config.get('kong.insecureSSL', false)) {
    kong.setValidateCertificates(false);
}

// So, to maintain compatibility with the existing OAuth URLs, we need to support
// a URL that does not start with an API URL. For that reason, we optionally specify a default
// API that we automatically append to Kong requests if an API is absent. If this is unset,
// then all requests that don't have a :api component will use th empty string. This is
// to allow APIs that are at the root of a particular host.
const defaultApi = config.get('server.defaultApi', '');
const authorizePath = config.get('server.routes.authorize', 'oauth2/login');
const profilePath = config.get('server.routes.introspection', 'oauth2/validate');
const impersonatePath = config.get('server.routes.impersonation', false);
const logoutPath = config.get('server.routes.logout', 'oauth2/logout');

const userGroupsHeader = config.get('introspection.headers.groups', null);

debug(`Default API set to ${defaultApi}`);

/**
 * Authorize the user through whatever our Passport SSO strategy is. Once we get
 * into the code for this handler, we're already authenticated.
 */
app.get([`/:api/${authorizePath}`, `/${authorizePath}`], passport.authenticate(strategy, { session: false }), function (req, res) {
    debug('Authorize request parameters:', req.params);
    debug('Authenticated user, getting client information from Kong...');

    if (_.intersection(['client_id', 'response_type'], _.keys(req.query)).length !== 2) {
        return utils.renderError(req, res, {
            status: 400,
            details: '`client_id` and `response_type` are required query parameters.'
        });
    }

    // First, we gotta fetch the client so we have it's information, including
    // credentials for later provisioning of the access token.
    debug('Fetching client details...');
    return kong.getClient(req.query.client_id).then(function (client) {
        // The API is a combination of the requested hostname and the API url.
        const api = `${req.hostname}/${req.params.api ? req.params.api : defaultApi}`;

        debug(`Using API ${api}`);

        // See if consent is enabled. If it is, we have to ask the user for consent
        // before issuing a token.
        if (config.get('kong.enableConsent', true)) {
            debug('Asking user for consent...');  
        } else {
            debug('Skipping user consent as it\'s globally disabled.');

            // Provision an Access Token through Kong for the API.            
            return kong.provision(api, client, req.query, req.user.user).then(function (response) {
                // Kong will provide the Redirect URI to send the user to.
                debug(`Redirecting client to ${response.redirect_uri}`);
                return res.redirect(301, response.redirect_uri);
            }).catch(function (error) {
                return utils.renderError(req, res, error);
            });
        }
        return res.status(200).send(client);
    }).catch(function (error) {
        return utils.renderError(req, res, error);
    });
});

app.all([`/:api/${authorizePath}`, `/${authorizePath}`], function (req, res) {
    return utils.renderError(req, res, {
        status: 405,
        details: 'Method not allowed'
    });
});

app.get([`/:api/${logoutPath}`, `/${logoutPath}`], function (req, res) {
    debug('Logout parameters: ', req.query);

    var clientId = req.query['client_id'];
    var redirectUri = req.query['redirect_uri'];
    var token = req.query['token'];

    function logout() {
        if (!_.isNil(redirectUri) && _.trim(redirectUri).length > 0) {
            if ((_.isNil(clientId) || _.trim(clientId).length === 0)) {
                return utils.renderError(req, res, {
                    status: 400,
                    details: 'A client ID is required when specifying a redirect URI.'
                });

            }

            debug(`Loading client details for ${clientId}...`);
            return kong.getClient(req.query['client_id']).then(function (client) {
                debug(`Verifying that ${redirectUri} is valid for client ${clientId}...`);
                const match = _.find(client.redirect_uri, function (uri) {
                    debug(` - Testing against ${uri}...`);
                    return _.trim(redirectUri).match(uri);
                });

                if (_.isNil(match)) {
                    return utils.renderError(req, res, {
                        status: 400,
                        details: `${redirectUri} is not valid for ${clientId}.`
                    });
                }

                req.logout();

                if (_.has(authStrategies[strategy], 'logoutHandler')) {
                    return authStrategies[strategy].logoutHandler(req, res, redirectUri);
                } else {
                    return res.redirect(301, redirectUri);
                }
            });
        } else {
            req.logout();

            if (_.has(authStrategies[strategy], 'logoutHandler')) {
                return authStrategies[strategy].logoutHandler(req, res, redirectUri);
            } else {
                return res.status(200).render(`logout-${req.accepts('json') ? 'json' : 'html'}`);
            }
        }
    }

    if (!_.isNil(token)) {
        return kong.deleteToken(token).then(logout).catch(function (error) {
            if (error.status === 404) {
                logout();
            } else {
                return utils.renderError(req, res, error);
            }
        });
    } else {
        return logout();
    }    
});

app.all([`/:api/${logoutPath}`, `/${logoutPath}`], function (req, res) {
    return utils.renderError(req, res, {
        status: 405,
        details: 'Method not allowed'
    });
});

/**
 * Simple introspection endpoint that returns the consumer and user
 * information as a JSON response. Useful for APIs that are not behind
 * Kong or that want to query for introspection details.
 */
app.get([`/:api/${profilePath}`, `/${profilePath}`], function (req, res) {
    debug('Validate request with headers:', req.headers);
    if (_.intersection(['x-consumer-username', 'x-consumer-id', 'x-authenticated-userid'], _.keys(req.headers)).length === 0) {
        return utils.renderError(req, res, {
            status: 401,
            details: 'Full authentication is required to access this resource'
        });
    }

    var consumerGroups = req.headers['x-consumer-groups'] || [];
    var groups = req.headers['x-consumer-groups'] || [];
    var userGroups = [];

    if (userGroupsHeader && userGroupsHeader in req.headers) {
        userGroups = req.headers[userGroupsHeader].split(',')
        groups = groups.concat(userGroups);
    }

    if (_.isString(groups)) {
        groups = groups.split(',').map(x => x.trim());
    }

    debug(`User ${req.headers['x-authenticated-userid']} logged in through ${req.headers['x-consumer-username']} with groups ${groups}.`);
    
    var vars = {
        consumer: {
            name: req.headers['x-consumer-username'],
            id: req.headers['x-consumer-id'],
            groups: consumerGroups
        },
        authorities: groups,
        actualUser: 'x-authenticated-actual-userid' in req.headers ? req.headers['x-authenticated-actual-userid'] : req.headers['x-authenticated-userid'],
        user: {
            name: req.headers['x-authenticated-userid'],
            groups: userGroups
        },
        headers: req.headers
    };

    if ('x-consumer-custom-id' in req.headers) {
        vars.consumer['customId'] = req.headers['x-consumer-custom-id'];
    }

    return res.render('introspection', vars);
});

app.all([`/:api/${profilePath}`, `/${profilePath}`], function (req, res) {
    return utils.renderError(req, res, {
        status: 405,
        details: 'Method not allowed'
    });
});

/**
 * Route at which users can impersonate other users, only define if set.
 */
if (impersonatePath) {
    debug(`Enabling OAuth 2.0 impersonation at ${impersonatePath}...`);

    app.post([`/:api/${impersonatePath}/:target`, `/${impersonatePath}/:target`], function (req, res) {
        const token = utils.parseToken(req);

        if (!token) {
            return utils.renderError(req, res, {
                status: 401,
                details: 'Full authentication is required to access this resource'
            });
        }

        const target = req.params.target;
        const api = `${req.params.api ? req.params.api : defaultApi}`;

        return kong.impersonate(target, api, token).then(function (result) {
            return res.status(result.status).send(result.data);
        }).catch(function (error) {
            return utils.renderError(req, res, {
                status: error.status,
                details: error.data
            });
        });
    });

    app.delete([`/:api/${impersonatePath}`, `/${impersonatePath}`], function (req, res) {
        const token = utils.parseToken(req);

        if (!token) {
            return utils.renderError(req, res, {
                status: 401,
                details: 'Full authentication is required to access this resource'
            });
        }

        const api = `${req.params.api ? req.params.api : defaultApi}`;

        return kong.unimpersonate(api, token).then(function (result) {
            return res.status(result.status).send(result.data);
        }).catch(function (error) {
            return utils.renderError(req, res, {
                status: error.status,
                details: error.data
            });
        });
    });

    app.all([`/:api/${impersonatePath}`, `/${impersonatePath}`], function (req, res) {
        return utils.renderError(req, res, {
            status: 405,
            details: 'Method not allowed'
        });
    });
}

app.all('*', function (req, res) {
    return utils.renderError(req, res, {
        status: 404,
        details: 'Not Found'
    });
});

if (process.env.NODE_ENV === 'development') {
    app.use(require('errorhandler'));
}

app.use(require('cookie-parser'));
app.use(require('body-parser'));
app.use(passport.initialize());

app.listen(argv.port, argv.host, function() {
    console.log(`Kong OAuth 2.0 Authenticator Listening on ${argv.host}:${argv.port}`);
});
