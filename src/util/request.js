import { default as baseRequest } from 'js-utility-belt/lib/request'
import sanitize from 'js-utility-belt/lib/sanitize'

const DEFAULT_REQUEST_CONFIG = {
    credentials: 'include',
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    }
}

/**
 * Small wrapper around js-utility-belt's request that provides default settings and response
 * handling
 */
export default function request(url, config) {
    // Load default fetch configuration and remove any falsey query parameters
    const requestConfig = Object.assign({}, DEFAULT_REQUEST_CONFIG, config, {
        query: config.query && sanitize(config.query)
    })

    return baseRequest(url, requestConfig)
        .then((res) => res.json())
        .catch((err) => {
            console.error(err)
            throw err
        })
}
