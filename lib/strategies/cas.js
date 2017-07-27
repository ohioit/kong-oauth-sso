'use strict';
var config = require('config');
var debug = require('debug')('ohio::kosso::cas');

debug('Initializing CAS Authentication Strategy...');

module.exports = {
    strategy: new (require('passport-cas').Strategy)({
        version: 'CAS3.0',
        ssoBaseURL: config.get('authentication.url'),
        serverBaseURL: config.get('server.publicUrl'),
    }, function (profile, done) {
        debug(`User ${profile.user} logged in with attributes:`, profile);
        return done(null, profile);
    }),
    logoutHandler: function (req, res, service) {
        return res.redirect(301, `${config.get('authentication.url')}/logout?service=${encodeURIComponent(service)}`);
    }
};
