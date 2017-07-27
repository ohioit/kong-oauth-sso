'use strict';
/**
 * Miscaleneous utility functions.
 *
 * @author Ilya Kogan <kogan@ohio.edu>
 */
const statuses = require('statuses');

module.exports = {
    renderError: function (req, res, error) {
        const contentType = req.accepts('json') ? 'json' : 'text';

        return res.status(error.status).render(`error-${contentType}`, {
            code: error.status,
            status: statuses[error.status],
            details: error.details
        });
    }
};
