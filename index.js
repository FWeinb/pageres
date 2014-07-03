'use strict';
var fs = require('fs');
var path = require('path');
var urlMod = require('url');
var spawn = require('child_process').spawn;
var _ = require('lodash');
var assign = require('object-assign');
var base64 = require('base64-stream');
var eachAsync = require('each-async');
var fileUrl = require('file-url');
var getRes = require('get-res');
var memoize = require('memoize-async');
var phantomjs = require('phantomjs').path;
var slugifyUrl = require('slugify-url');
var viewport = require('viewport-list');

/**
 * Initialize Pageres
 *
 * @param {Object} options
 * @api public
 */

function Pageres(options) {
	if (!(this instanceof Pageres)) {
		return new Pageres();
	}

	options = options || {};
	this.options = options;
	this._src = [];
	this.items = [];
	this.sizes = [];
	this.urls = [];
	this.stats = {};
}

/**
 * Add a page to take screenshot of
 *
 * @param {String} url
 * @param {String|Array} size
 * @api public
 */

Pageres.prototype.src = function (url, size) {
	if (!arguments.length) {
		return this._src;
	}

	this._src.push({ url: url, sizes: size });
	return this;
};

/**
* Set or get the destination dir
*
* @param {String} dir
* @api public
*/

Pageres.prototype.dest = function (dir) {
	if (!arguments.length) {
		return this._dest;
	}

	this._dest = dir;
	return this;
};

/**
 * Run pageres
 *
 * @param {Function} cb
 * @api public
 */

Pageres.prototype.run = function (cb) {
	var self = this;

	if (!phantomjs) {
		return cb('The automatic install of PhantomJS, which is used for generating the screenshots, seems to have failed.\nTry installing it manually: http://phantomjs.org/download.html');
	}

	eachAsync(this.src(), function (src, i, next) {
		var sizes = _.uniq(src.sizes.filter(/./.test, /^\d{3,4}x\d{3,4}$/i));
		var keywords = _.difference(src.sizes, sizes);

		if (!src.url) {
			return cb(new Error('URL required'));
		}

		self.urls.push(src.url);

		if (sizes.length === 0 && keywords.length === 0) {
			return self.resolution(src.url, next);
		}

		if (keywords.length > 0) {
			return self.viewport(src.url, sizes, keywords, next);
		}

		sizes.forEach(function (size) {
			self.sizes.push(size);
			self.items.push(self.generate(src.url, size));
		});

		next();
	}, function (err) {
		if (err) {
			return cb(err);
		}

		self.stats.screenshots = _.uniq(self.sizes).length;
		self.stats.urls = _.uniq(self.urls).length;

		if (!self.dest()) {
			return cb(null, self.items);
		}

		self.save(self.items, cb);
	});
};

/**
 * Fetch ten most popular resolutions
 *
 * @param {String} url
 * @param {Function} cb
 * @api public
 */

Pageres.prototype.resolution = function (url, cb) {
	var self = this;
	var g = memoize(getRes);

	g(function (err, res) {
		if (err) {
			return cb(err);
		}

		self._resolutions = res;

		res.forEach(function (size) {
			self.sizes.push(size.item);
			self.items.push(self.generate(url, size.item));
		});

		cb();
	});
};

/**
* Fetch keywords
*
* @param {String} url
* @param {Array} sizes
* @param {Array} keywords
* @param {Function} cb
* @api public
*/

Pageres.prototype.viewport = function (url, sizes, keywords, cb) {
	var self = this;
	var v = memoize(viewport);

	v(keywords, function (err, res) {
		if (err) {
			return cb(err);
		}

		res.forEach(function (r) {
			self.sizes.push(r.size);
			sizes.push(r.size);
		});

		_.uniq(sizes).forEach(function (size) {
			self.items.push(self.generate(url, size));
		});

		cb();
	});
};

/**
 * Save screenshots
 *
 * @param {Array} items
 * @param {Function} cb
 * @api public
 */

Pageres.prototype.save = function (items, cb) {
	var self = this;

	eachAsync(items, function (item, i, next) {
		var stream = item.pipe(fs.createWriteStream(path.join(self.dest(), item.filename)));

		item.on('error', next);

		stream.on('finish', next);
		stream.on('error', next);
	}, function (err) {
		if (err) {
			return cb(err);
		}

		cb(null, items);
	});
};

/**
 * Generate screenshots
 *
 * @param {String} url
 * @param {String} size
 * @api public
 */

Pageres.prototype.generate = function (url, size) {
	var isFile = fs.existsSync(url);
	var name;
	var newUrl;

	if (isFile) {
		newUrl = fileUrl(url);
	} else {
		newUrl = url.replace(/^localhost/, 'http://$&');
		newUrl = urlMod.parse(newUrl).protocol ? newUrl : 'http://' + newUrl;
	}

	name = slugifyUrl(isFile ? url : newUrl).replace(/^(?:https?:\/\/)?www\./, '');
	name = name + '-' + size + '.png';

	// TODO add option to switch between phantom/nodeWebkit
	// var stream = this.phantom(assign({ delay: 0 }, this.options, {
	var stream = this.nodeWebkit(assign({ delay: 0 }, this.options, {
		url: newUrl,
		width: size.split(/x/i)[0],
		height: size.split(/x/i)[1]
	}));

	stream.filename = name;
	return stream;
};

/**
 * Run Phantom JS
 *
 * @param {Object} options
 * @api public
 */

Pageres.prototype.phantom = function (options) {
	var cp = spawn(phantomjs, [
		path.join(__dirname, 'converter.js'),
		JSON.stringify(options)
	]);

	var stream = cp.stdout.pipe(base64.decode());
	process.stderr.setMaxListeners(0);

	cp.stdout.on('data', function (data) {
		if (/Couldn\'t load url/.test(data)) {
			return stream.emit('error', new Error('Couldn\'t load url'));
		}
	});

	cp.stderr.on('data', function (data) {
		if (/ phantomjs\[/.test(data)) {
			return;
		}

		stream.emit('error', data);
	});

	return stream;
};

/**
 * Run node webkit
 *
 * @param {Object} options
 * @api public
 */

Pageres.prototype.nodeWebkit = function (options) {
	// Start node-webkit
	var cp = spawn('node-webkit', [
		path.join(__dirname, 'nw-screenshot'),
		JSON.stringify(options)
	]);
	// nw-app will
	return cp.stdout;
};


module.exports = Pageres;
