'use strict';
/**
 * Miscaleneous utility functions.
 *
 * @author Ilya Kogan <kogan@ohio.edu>
 */
const statuses = require('statuses');
const debug = require('debug')('ohio::kosso::utils');

module.exports = {
    renderError: function (req, res, error) {
        const contentType = req.accepts('json') ? 'json' : 'text';

        return res.status(error.status).render(`error-${contentType}`, {
            code: error.status,
            status: statuses[error.status],
            details: error.details
        });
    },

    parseToken: function(req) {
        debug('Ensuring the presence of an access token before starting impersonation...');
        var token = req.query['access_token'];
        if (!token && 'authorization' in req.headers) {
            var pieces = req.headers['authorization'].split(' ');
            if (pieces[0].toLowerCase() === 'bearer') {
                token = pieces[1]
            }
        }

        return token;
    }
};
