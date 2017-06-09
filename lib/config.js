'use strict';
/**
 * This module is a simple wrapper around `config` that allows
 * us to specify defaults with `get` calls.
 *
 * @author Ilya Kogan <kogan@ohio.edu>
 */
const config = require('config');

module.exports = {
    /**
     * Similar to upstream, if `defvalue` is omitted,
     * `config.get(key)` is called. If not, then use
     * `config.has(key)` to test for the presence of `key`
     * and return the default value if it's  absent.
     *
     * @param key string The Key too look for in the configuration.
     * @param defvalue * The default value to return if it's missing.
     * @return * The value from the configuration, or the default.
     */
    get: function (key, defvalue) {
        if (typeof defvalue === 'undefined') {
            return config.get(key);
        } else {
            return config.has(key) ? config.get(key) : defvalue;
        }
    },

    /**
     * `config.has` is still useful so provide access to
     * it as well.
     *
     * @param key string The key in configuration file.
     * @return boolean Whether or not the key exists.
     */
    has: function (key) {
        return config.has(key);
    }
};
