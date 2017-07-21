'use strict';

const _ = require('lodash');
const config = require('./lib/config');
const passport = require('passport');
const express = require('express');
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
debug('Looking for available authentication strategies...');
fs.readdirSync('./lib/strategies').forEach(function (entry) {
    var name = path.basename(entry, 'js');

    if (name.lastIndexOf('.')) {
        name = name.slice(0, -1);
    }

    debug(`Plugging in strategy ${name}...`);
    passport.use(name, require(`./lib/strategies/${name}`));
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

debug(`Default API set to ${defaultApi}`);

/**
 * Authorize the user through whatever our Passport SSO strategy is. Once we get
 * into the code for this handler, we're already authenticated.
 */
app.get([`/:api/${authorizePath}`, `/${authorizePath}`], passport.authenticate(strategy, { session: false }), function (req, res) {
    debug('Authorize request parameters:', req.params);
    debug('Authenticated user, getting client information from Kong...');

    if (_.intersection(['client_id', 'response_type'], _.keys(req.query)).length !== 2) {
        return res.status(400).send('400 Bad Request. `client_id` and `response_type` are required query parameters.');
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
            return kong.provision(api, client, req.query.response_type, req.query.scope, req.user.user).then(function (response) {
                // Kong will provide the Redirect URI to send the user to.
                debug(`Redirecting client to ${response.redirect_uri}`);
                return res.redirect(301, response.redirect_uri);
            }).catch(function (error) {
                return res.status(error.status).send(error.details);
            });
        }
        return res.status(200).send(client);
    }).catch(function (error) {
        return res.status(error.status).send(error.details);
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
        return res.status(401).contentType('application/json').render('401');
    }

    var groups = req.headers['x-consumer-groups'] || [];

    if (_.isString(groups)) {
        groups = groups.split(',').map(x => x.trim());
    }

    debug(`User ${req.headers['x-authenticated-userid']} logged in through ${req.headers['x-consumer-username']} with groups ${groups}.`);
    
    return res.render('introspection', {
        consumer: {
            name: req.headers['x-consumer-username'],
            id: req.headers['x-consumer-id'],
            groups: groups
        },
        user: {
            name: req.headers['x-authenticated-userid']
        }
    });
});

/**
 * For all undefined URLs, puke out a 404.
 */
app.get('*', function (req, res) {
    res.status(404).send('404 Not Found.');
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
