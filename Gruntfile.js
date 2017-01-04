'use strict'

var path = require('path')
var webpack = require('webpack')
var commonsPlugin = new webpack.optimize.CommonsChunkPlugin('common.js')

const nodeEnv = process.env.NODE_ENV || 'development'
const isProduction = nodeEnv === 'production'
const webRoot = 'web'
const vendorDir = `${webRoot}/public/vendor/`
const babelDir = `${webRoot}/public/js/babel/`
const srcDir = `${webRoot}/public/js/src/`
const distDir = `${webRoot}/public/js/dist/`
const lessDir = `${webRoot}/public/less/`
const cssDir = `${webRoot}/public/css/`

let joinPath = (cwd, f) => {
  if (f.indexOf('!') === 0) {
    return '!' + cwd + f.substr(1)
  }
  return cwd + f
}

let uglifyRename = (dest, src) => {
  return path.join(dest, src.replace(/\.js$/, '.min.js'))
}

module.exports = (grunt) => {
  const themes = [
    'default'
  ]
  const compressScripts = [
    'colorbrewer/colorbrewer.js',
    'fastclick/fastclick.js'
  ]
  const compressStylesheets = [
    'normalize-css/normalize'
  ].map((f) => joinPath(vendorDir, f))
  const jshintFiles = [
    '**/*.js',
    '!**/*.min.js'
  ].map((f) => joinPath(srcDir, f))
  const uglifyFiles = [
    '**/*.js',
    '!**/*.min.js'
  ]
  const webpackScripts = [
    // 'views/index'
  ]

  const webpackConfig = {
    cache: false,
    entry: (() => {
      let entries = {}
      webpackScripts.forEach((s) => {
        entries[s] = `./${srcDir}${s}.js`
      })
      return entries
    })(),
    output: {
      path: path.join(__dirname, distDir),
      filename: '[name].min.js',
      chunkFilename: '[chunkhash].js'
    },
    resolve: {
      extensions: ['', '.js']
    },
    module: {
      loaders: [{
        test: /\.js$/,
        loader: 'babel',
        query: {
          presets: ['es2015']
        }
      }]
    },
    plugins: [commonsPlugin]
  }
  const uglifyConfig = {
    mangle: false,
    beautify: !isProduction,
    compress: {
      unused: false,
      side_effects: false
    },
    sourceMap: false,
    preserveComments: false,
    report: 'gzip',
    banner: isProduction ? '/*\n <%= pkg.name %> - v<%= pkg.version %> - <%= grunt.template.today("yyyy-mm-dd") %>\n*/' : ''
  }
  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    bower: {
      install: {
        options: {
          targetDir: vendorDir,
          verbose: !isProduction,
          layout: 'byComponent',
          cleanTargetDir: true,
          bowerOptions: {
            production: isProduction
          }
        }
      }
    },
    less: (() => {
      let conf = {}
      let ts = ['development', 'production']

      ts.forEach((c) => {
        conf[c] = {
          options: {
            compress: isProduction
          },
          files: (() => {
            let files = {}
            themes.forEach((theme) => {
              files[`${cssDir}${theme}.min.css`] = `${lessDir}${theme}.less`
            })
            return files
          })()
        }
      })
      return conf
    })(),
    jshint: {
      options: {
        jshintrc: '.jshintrc',
        verbose: true
      },
      files: jshintFiles
    },
    csslint: {
      options: {
        csslintrc: `${lessDir}.csslintrc`
      },
      dist: themes.map((theme) => `${cssDir}${theme}.min.css`)
    },
    cssmin: {
      options: {
        shorthandCompacting: false,
        roundingPrecision: -1
      },
      target: {
        files: (() => {
          let conf = {}
          compressStylesheets.map((s) => {
            conf[`${s}.min.css`] = `${s}.css`
          })
          return conf
        })()
      }
    },
    uglify: {
      options: uglifyConfig,
      scripts: {
        files: [{
          expand: true,
          cwd: babelDir,
          src: uglifyFiles,
          dest: distDir,
          rename: uglifyRename
        }]
      },
      bowerScripts: {
        options: {
          compress: true,
          beautify: false
        },
        files: [{
          expand: true,
          cwd: vendorDir,
          src: compressScripts,
          dest: vendorDir,
          rename: uglifyRename
        }]
      }
    },
    babel: {
      options: {
        sourceMap: false
      },
      babelify: {
        files: [{
          expand: true,
          cwd: srcDir,
          src: ['**/*.js', '!**/*.min.js'].concat(webpackScripts.map((s) => `!${s}.js`)),
          dest: babelDir,
          ext: '.js'
        }]
      }
    },
    clean: {
      options: {
        force: true
      },
      label: [`${babelDir}**/*`],
      dist: [`${distDir}**/*`]
    },
    webpack: {
      options: webpackConfig,
      build: {
        plugins: (() => {
          let plugins = [
            new webpack.DefinePlugin({
              'process.env': {
                'NODE_ENV': process.env.NODE_ENV
              }
            }),
            new webpack.optimize.DedupePlugin()
          ]
          if (isProduction) {
            plugins.push(new webpack.optimize.UglifyJsPlugin(uglifyConfig))
          }
          return plugins
        })()
      },
      'build-dev': {
        devtool: 'sourcemap',
        debug: true
      }
    },
    'webpack-dev-server': {
      options: {
        webpack: webpackConfig,
        publicPath: '/' + webpackConfig.output.publicPath
      },
      start: {
        keepAlive: true,
        webpack: {
          devtool: 'eval',
          debug: true
        }
      }
    },
    copy: {
      libs: {
        files: [
          { expand: true, cwd: srcDir, src: ['libs/*.min.js'], dest: distDir }
        ]
      }
    },
    watch: {
      options: {
        event: ['changed', 'added']
      },
      files: ['public/less/**/*.less', '<%= jshint.files %>'],
      tasks: ['compress']
    }
  })

  grunt.loadNpmTasks('grunt-contrib-cssmin')
  grunt.loadNpmTasks('grunt-contrib-copy')
  grunt.loadNpmTasks('grunt-contrib-jshint')
  grunt.loadNpmTasks('grunt-contrib-watch')
  grunt.loadNpmTasks('grunt-bower-task')
  grunt.loadNpmTasks('grunt-contrib-less')
  grunt.loadNpmTasks('grunt-contrib-uglify')
  grunt.loadNpmTasks('grunt-contrib-csslint')
  grunt.loadNpmTasks('grunt-contrib-clean')
  grunt.loadNpmTasks('grunt-babel')
  grunt.loadNpmTasks('grunt-webpack')

  grunt.registerTask('lint', ['jshint', 'csslint'])
  grunt.registerTask('compress:css', [`less:${nodeEnv}`, 'csslint'])
  grunt.registerTask('compress:js', ['jshint', 'clean', 'babel:babelify', 'uglify:scripts', 'webpack:build', 'copy'])
  grunt.registerTask('compress', ['compress:css', 'compress:js'])
  grunt.registerTask('bowerComponents', ['bower:install', 'uglify:bowerScripts', 'cssmin'])
  grunt.registerTask('default', ['watch'])
}
