# Kong OAuth SSO Integration

Small express based integration between the
[Kong API gateway](https://github.com/Mashape/kong) and any
[Passenger](https://github.com/phusion/passenger) supported authentcation
solution. This provides the following features:

- Authorization URL supporting Authorization Code grants that provisions
  OAuth tokens via Kong's authorization endpoint.
- Authentication via Passport with pluggable authentication strategies.
  - Currently only CAS is implemented, but they're fairly trivial. See below.
- Simple introspection endpoint that, when setup behind Kong, returns user
  and consumer information as JSON.

> Note: The user consent prompt is not implemented so the `enableConsent` flag
must always be false in the configuration. This should be implemented shortly.

## Architecture

This is designed to implement the flow specified in Kon's OAuth 2.0 plugin API as
documented in [Kong's documentation](https://getkong.org/plugins/oauth2-authentication/)

![Kong OAuth Flow](https://getkong.org/assets/images/docs/oauth2/oauth2-flow.png)

This app implements the two boxes at the top, steps 2 - 7. Rather than providing
a login screen of it's own, it delegates authentication to a third party system
via Passenger. Currently only the CAS strategy is implemented using the CAS 3.0
protocol. Once the third party system authenticates the user, this app will prompt
for user consent and send a `POST` request to Kong to provision the access token
and, if all goes well, redirect the user back to their application with the
authorization code it can use to retrieve it's token from Kong.

> Note that the app will need to have access to the Kong API to retrieve client
credentials to properly provision access tokens.

## Usage

You'll first have to create a `config/default.json` or an environment specific
configuration file (see [config](https://www.npmjs.com/package/config) for details).
A short sample is provided and detailed documentation about the options is available
below. Then, simply start the server and point your application at the configured
endpoints.

## Configuration

The configuration file must be well formed JSON and be of the following form:

```json
{
  "server": {
    "host": "0.0.0.0",                      # IP/Host on which to listen
    "port": 3000,                           # Port on which to listen
    "publicUrl": "https://api.mydomain.com" # Publicly accessible URL for this service. Used for the SSO redirect URL.
    "routes": {
        "authorize": "oauth/authorize",     # URL on which to accept authorize calls
        "introspection": "oauth/validate"   # URL on which to respond to profile/validate requests
    },
    "defaultApi": "auth"                    # Default Kong API to reference for all requests, see below.
  },
  "authentication": {
    "url": "https://sso.mydomain.com"       # URL at which the SSO system resides
  },
  "kong": {
      "api": "http://kong:8001",            # Base URL the Kong API
      "gateway": "https://kong:8443",       # Base URL to the Kong gateway
      "provisionKey": "12345",              # Provision key provided by Kong
      "insecureSSL": true,                  # Whether to validate Kong's SSL certificate
      "enableConsent": false                # Enable the user consent prompt, see below
  },
  "clients": {                              # List of client specific settings

  },
  "ui": {
    "theme": "default"                      # The UI theme to use, see below.
  },
  "authentication": {
      "strategy": "cas"                     # Authenticate strategy to use, see below.
  }
}

```

### Default API

Since OAuth is implemented as an API plugin in Kong, there isn't a "global" endpoint
for OAuth. However, it may be undesirable to force clients to specify a Kong API to
which to authenticate. For this reason, the `defaultApi` may be used to prepend all
Kong requests with the specified value.

> Note: Access Tokens can be global in Kong by checking the "Global Credentials" flag
when adding OAuth to an API and should be used if `defaultApi` is used.

For example, if `defaultApi` is set to `auth` and `https://api.mydomain.com/oauth` is
proxied to this integration component, then requests to
`https://api.mydomain.com/oauth/authorize` will be cause requests to be sent to
`/auth/oauth2/authorize` in Kong.

### Consent Screen

In some cases a consent screen is not desirable. If the owner of the data, the API,
and the application are all the same entity, it's hardly desriable to demand the
user approve access. In this case, the `enableConsent` flag can be set to `false`
to disable the consent screen.

> Note: Currently, this is the only supported behavior. Flipping `enableConsent` to
`true` will result in undefined behavior. Additionally, this is currently a global
setting. In the future, it should be possible to define consent on a per client
and per API basis.

### Themeing

This integration uses [Handlebars](http://handlebarsjs.com/) templates and Express
views to implement various responses. To change the way responses are formatted,
simply copy the `views/default` directory into another directory in `views` and set
the `ui.theme` property in the config to match the directory name.

### Authentication Strategy

Since this integration uses Passport to implement authentication, adding an additonal
strategy is trivial. Simply create a new module in the `lib/strategies` directory
named after your strategy and return a complete Password strategy as the module.
See the included `lib/strategies/cas.js` for a simple example.

## Introspection

While Kong will provide user and consumer details as HTTP headers to APIs behind
Kong, it does not include an exposed endpoint that an external application, that is,
one not behind Kong, can use to determine who is logged in to which client. This
server implements such an endpoint. For this to work, the introspection endpoint
(as defined in the configuration) should be proxied by Kong. It will use the
HTTP headers sent by Kong to generate a JSON representation as a response. In this
scenario, this application's _authorize_ endpoint would be publicly exposed while it's
introspection endpoint would be behind Kong, requiring OAuth 2.0 authentication.

## Docker

One of the easiest ways to run this is through Docker. The standard `nodejs` Docker
image should be used and can be invoked in the following way:

```
    kong_oauth_sso:
        image: node
        command: "node --inspect=0.0.0.0:5858 server.js"
        working_dir: "/usr/src/app"
        networks:
            - private
        ports:
            - "127.0.0.1:5858:5858"
        volumes:
            - "../kong-oauth-sso:/usr/src/app"
        environment:
            - NODE_DEBUG=request
            - DEBUG=*
            - >
                NODE_CONFIG={"server": {"publicUrl": "${PUBLIC_URL}"},"kong": {"provisionKey": "${KONG_SSO_PROVISION_KEY}"},"authentication":{"url": "${KONG_SSO_URL}"}}
        hostname: kong_oauth_sso
        links:
            - kong:kong
```

```
docker run -ti node -w /usr/src/app -v "$(pwd)":/usr/src/app -p 3000:3000 "node server.js"
```

All part of the configuration can be specified on the environment as a JSON object,
for example:

```
docker run -ti node -w /usr/src/app -v "$(pwd)":/usr/src/app -p 3000:3000 -e 'NODE_CONFIG={"server": {"publicUrl": "https://api.mydomain.com"}}' "node server.js"
```

## Verbose Logging

The `debug` module is used for more detailed output. Add the `DEBUG=*` environment
variable to see more output. See
[debug's documentation](https://www.npmjs.com/package/debug) for more details.
