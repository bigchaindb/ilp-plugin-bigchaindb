/* eslint-disable strict, no-console, object-shorthand */
/* eslint-disable import/no-extraneous-dependencies, import/newline-after-import */

'use strict'

const path = require('path')

const webpack = require('webpack')
const combineLoaders = require('webpack-combine-loaders')

const PRODUCTION = process.env.NODE_ENV === 'production'

const PATHS = {
    ILP_PLUGIN: path.resolve(__dirname, 'src/lib/bigchaindb_ledger_plugin.js'),

    BUILD: path.resolve(__dirname, 'build'),
    BUNDLE: path.resolve(__dirname, 'bundle'),
    NODE_MODULES: path.resolve(__dirname, 'node_modules'),
}

/** EXTERNAL DEFINITIONS INJECTED INTO APP **/
const DEFINITIONS = {
    'process.env': {
        NODE_ENV: JSON.stringify(process.env.NODE_ENV || 'development'),
        BDB_SERVER_URL: JSON.stringify(`${process.env.BDB_SERVER_URL || 'http://localhost:9984'}`),
        BDB_WS_URL: JSON.stringify(`${process.env.BDB_WS_URL || 'ws://localhost:9985'}`),
    },
}


/** PLUGINS **/
const PLUGINS = [
    new webpack.DefinePlugin(DEFINITIONS),
    new webpack.NoEmitOnErrorsPlugin(),
]

const PROD_PLUGINS = [
    new webpack.optimize.UglifyJsPlugin({
        compress: {
            warnings: false
        },
        output: {
            comments: false
        },
        sourceMap: true,
    }),
    new webpack.LoaderOptionsPlugin({
        debug: false,
        minimize: true
    }),
]


if (PRODUCTION) {
    PLUGINS.push(...PROD_PLUGINS)
}


/** LOADERS **/
const JS_LOADER = combineLoaders([
    {
        loader: 'babel-loader',
        options: {
            presets: ['es2015'],
        },
        query: {
            cacheDirectory: true,
        },
    },
])


const LOADERS = [
    {
        test: /\.jsx?$/,
        exclude: [PATHS.NODE_MODULES],
        loader: JS_LOADER,
    },
]


/** EXPORTED WEBPACK CONFIG **/
module.exports = {
    entry: PATHS.ILP_PLUGIN,

    output: {
        filename: PRODUCTION ? 'bundle.min.js' : 'bundle.js',
        library: 'ilp-plugin-bigchaindb',
        libraryTarget: 'umd',
        path: PRODUCTION ? PATHS.BUNDLE : PATHS.BUILD,
    },

    devtool: PRODUCTION ? '#source-map' : '#inline-source-map',

    resolve: {
        extensions: ['.js', '.jsx'],
        modules: ['node_modules'], // Don't use absolute path here to allow recursive matching
    },

    plugins: PLUGINS,

    module: {
        rules: LOADERS,
    },
}
