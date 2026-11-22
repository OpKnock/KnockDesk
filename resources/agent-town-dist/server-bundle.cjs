"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       * @param {Boolean} [isServer=false] Create the instance in either server or
       *     client mode
       * @param {Number} [maxPayload=0] The maximum allowed message length
       */
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._isServer = !!isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch (e) {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate(
          opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
          false,
          opts.maxPayload
        );
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash } = require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate(
            this.options.perMessageDeflate,
            true,
            this.options.maxPayload
          );
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/server.ts
var import_http = require("http");
var import_next = __toESM(require("next"));

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/logger.ts
var isProd = typeof process !== "undefined" && process.env.NODE_ENV === "production";
function noop() {
}
function createLogger(tag) {
  const prefix = `[${tag}]`;
  if (isProd) {
    return {
      debug: noop,
      info: noop,
      warn: console.warn.bind(console, prefix),
      error: console.error.bind(console, prefix)
    };
  }
  return {
    debug: console.debug.bind(console, prefix),
    info: console.info.bind(console, prefix),
    warn: console.warn.bind(console, prefix),
    error: console.error.bind(console, prefix)
  };
}

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/ws-proxy.ts
var proxyLog = createLogger("WS Proxy");
var MAX_BUFFERED_MESSAGES = 100;
var UPSTREAM_CONNECT_TIMEOUT_MS = 15e3;
function isForwardableCloseCode(code) {
  return code === 1e3 || code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
}
function proxyWebSocket(clientWs, gatewayUrl) {
  const upstream = new import_websocket.default(gatewayUrl);
  const bufferedMessages = [];
  const connectTimeout = setTimeout(() => {
    if (upstream.readyState === import_websocket.default.CONNECTING) {
      proxyLog.error("upstream connection timeout");
      bufferedMessages.length = 0;
      upstream.terminate();
      if (clientWs.readyState === import_websocket.default.OPEN) {
        clientWs.close(1011, "Gateway connection timeout");
      }
    }
  }, UPSTREAM_CONNECT_TIMEOUT_MS);
  upstream.on("open", () => {
    clearTimeout(connectTimeout);
    for (const message of bufferedMessages) {
      upstream.send(message.data, { binary: message.isBinary });
    }
    bufferedMessages.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    try {
      if (clientWs.readyState === import_websocket.default.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    } catch (err) {
      proxyLog.error("send to client failed:", err.message);
    }
  });
  upstream.on("close", (code, reason) => {
    if (clientWs.readyState === import_websocket.default.OPEN) {
      const textReason = reason.toString();
      if (isForwardableCloseCode(code)) {
        clientWs.close(code, textReason);
      } else {
        clientWs.close();
      }
    }
  });
  upstream.on("error", (err) => {
    proxyLog.error("upstream error:", err.message);
    if (clientWs.readyState === import_websocket.default.OPEN) {
      clientWs.close(1011, "Gateway connection error");
    }
  });
  clientWs.on("message", (data, isBinary) => {
    if (upstream.readyState === import_websocket.default.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (upstream.readyState === import_websocket.default.CONNECTING && bufferedMessages.length < MAX_BUFFERED_MESSAGES) {
      bufferedMessages.push({ data, isBinary });
    }
  });
  clientWs.on("close", () => {
    clearTimeout(connectTimeout);
    bufferedMessages.length = 0;
    if (upstream.readyState === import_websocket.default.OPEN || upstream.readyState === import_websocket.default.CONNECTING) {
      upstream.close();
    }
  });
  clientWs.on("error", (err) => {
    proxyLog.error("client error:", err.message);
    if (upstream.readyState === import_websocket.default.OPEN) {
      upstream.close();
    }
  });
}
function checkOrigin(req, socket) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        proxyLog.warn(`Rejected WS upgrade: origin ${origin} does not match host ${host}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return false;
      }
    } catch {
      proxyLog.warn(`Rejected WS upgrade: invalid origin ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return false;
    }
  }
  return true;
}
function attachWsProxy(server, gatewayUrl, path = "/api/gateway") {
  const wss = new import_websocket_server.default({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === path) {
      if (!checkOrigin(req, socket)) return;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        proxyWebSocket(clientWs, gatewayUrl);
      });
    }
  });
  wss.on("error", (err) => {
    proxyLog.error("server error:", err.message);
  });
}

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/auggie-bridge.ts
var auggie_bridge_exports = {};
__export(auggie_bridge_exports, {
  attachAuggieBridge: () => attachAuggieBridge,
  dispatchToWorker: () => dispatchToWorker,
  setWorkerRoster: () => setWorkerRoster,
  validateDispatchSecret: () => validateDispatchSecret
});
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");
var log = createLogger("Auggie Bridge");
var runCounter = 0;
var activeClientState = null;
var workerRoster = [];
function sendFrame(state, frame) {
  if (state.ws.readyState !== import_websocket.default.OPEN) return;
  try {
    state.ws.send(JSON.stringify(frame));
  } catch (err) {
    log.error("sendFrame failed:", err.message);
  }
}
function sendEvent(state, event, payload) {
  sendFrame(state, { type: "event", event, payload, seq: state.seq++ });
}
function sendResponse(state, id, ok, payloadOrError) {
  const frame = { type: "res", id, ok };
  if (ok) {
    frame.payload = payloadOrError;
  } else {
    frame.error = payloadOrError;
  }
  sendFrame(state, frame);
}
function parseAuggieOutput(raw) {
  const idx = raw.indexOf("{");
  if (idx === -1) return null;
  try {
    return JSON.parse(raw.slice(idx));
  } catch {
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith("{")) {
        try {
          return JSON.parse(line);
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}
function checkOrigin2(req, socket) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        log.warn(`Rejected WS upgrade: origin ${origin} does not match host ${host}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return false;
      }
    } catch {
      log.warn(`Rejected WS upgrade: invalid origin ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return false;
    }
  }
  return true;
}
function buildWorkerRosterContext(currentSeatLabel) {
  if (workerRoster.length <= 1) return "";
  const others = workerRoster.filter((w) => w.label !== currentSeatLabel);
  if (others.length === 0) return "";
  const lines = others.map(
    (w) => `  \u2022 seatId="${w.seatId}" \u2014 ${w.label} (${w.roleTitle ?? "Worker"})`
  );
  return "\n\nYou have team members available. Use the dispatch_to_worker tool to delegate tasks:\n" + lines.join("\n") + "\n";
}
function buildPersonalityPrefix(params) {
  const label = params.seatLabel;
  const role = params.seatRole;
  if (!label && !role) return "[You are powered by Auggie. Stay in character when responding.]\n\n";
  const parts = [];
  if (label) parts.push(`Your name is "${label}".`);
  if (role) parts.push(`Your role is ${role}.`);
  parts.push("Stay in character when responding.");
  const rosterCtx = buildWorkerRosterContext(label);
  return `[${parts.join(" ")}${rosterCtx}]

`;
}
function handleChatSend(state, id, params) {
  const sessionKey = params.sessionKey ?? "default";
  const rawMessage = params.message ?? "";
  const runId = `auggie_${Date.now()}_${++runCounter}`;
  const message = buildPersonalityPrefix(params) + rawMessage;
  sendResponse(state, id, true, { runId, status: "accepted" });
  sendEvent(state, "agent", { runId, sessionKey, stream: "lifecycle", data: { phase: "start" } });
  const args = ["--print", "--output-format", "json"];
  const mcpConfigPath2 = writeMcpConfig();
  if (mcpConfigPath2) {
    args.push("--mcp-config", mcpConfigPath2);
  }
  const existingSessionId = state.sessionMap.get(sessionKey);
  if (existingSessionId) {
    args.push("--resume", existingSessionId);
  }
  args.push("--");
  args.push(message);
  log.info(`Spawning auggie for run ${runId}:`, ["auggie", ...args].join(" "));
  const port2 = process.env.PORT ?? "3000";
  let child;
  try {
    child = (0, import_child_process.spawn)("auggie", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_TOWN_PORT: port2,
        AGENT_TOWN_WORKERS: JSON.stringify(workerRoster),
        AGENT_TOWN_DISPATCH_SECRET: dispatchSecret
      }
    });
  } catch (err) {
    const errMsg = `Failed to spawn auggie: ${err.message}`;
    log.error(errMsg);
    sendEvent(state, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "error", error: errMsg }
    });
    sendEvent(state, "chat", { runId, sessionKey, state: "error" });
    return;
  }
  state.runningProcesses.set(runId, child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (err) => {
    log.error(`auggie process error for run ${runId}:`, err.message);
    state.runningProcesses.delete(runId);
    sendEvent(state, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "error", error: err.message }
    });
    sendEvent(state, "chat", { runId, sessionKey, state: "error" });
  });
  child.on("close", (code) => {
    state.runningProcesses.delete(runId);
    if (code === null || code !== 0) {
      const errMsg = stderr.trim() || `auggie exited with code ${code}`;
      log.error(`auggie failed for run ${runId}:`, errMsg);
      sendEvent(state, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "error", error: errMsg }
      });
      sendEvent(state, "chat", { runId, sessionKey, state: "error" });
      return;
    }
    const parsed = parseAuggieOutput(stdout);
    if (!parsed) {
      log.error(`auggie produced unparseable output for run ${runId}:`, stdout.slice(0, 500));
      sendEvent(state, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "error", error: "Failed to parse auggie output" }
      });
      sendEvent(state, "chat", { runId, sessionKey, state: "error" });
      return;
    }
    if (typeof parsed.session_id === "string") {
      state.sessionMap.set(sessionKey, parsed.session_id);
      log.debug(`Mapped sessionKey ${sessionKey} \u2192 auggie session ${parsed.session_id}`);
    }
    const responseText = typeof parsed.result === "string" ? parsed.result : typeof parsed.response === "string" ? parsed.response : JSON.stringify(parsed);
    sendEvent(state, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "end" }
    });
    sendEvent(state, "chat", {
      runId,
      sessionKey,
      state: "final",
      message: { content: [{ type: "text", text: responseText }] }
    });
    log.info(`Run ${runId} completed successfully`);
  });
}
function handleChatAbort(state, id, params) {
  const runId = params.runId;
  const sessionKey = params.sessionKey ?? "default";
  if (runId && state.runningProcesses.has(runId)) {
    const child = state.runningProcesses.get(runId);
    child.kill("SIGTERM");
    state.runningProcesses.delete(runId);
    log.info(`Aborted run ${runId}`);
  }
  sendResponse(state, id, true, {});
  if (runId) {
    sendEvent(state, "chat", { runId, sessionKey, state: "aborted" });
  }
}
async function handleModelsList(state, id) {
  try {
    const result = await new Promise((resolve, reject) => {
      const child = (0, import_child_process.spawn)("auggie", ["model", "list", "--json"], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`auggie model list exited with code ${code}`));
      });
      setTimeout(() => {
        child.kill();
        reject(new Error("timeout"));
      }, 1e4);
    });
    const parsed = parseAuggieOutput(result);
    if (parsed && Array.isArray(parsed.models)) {
      sendResponse(state, id, true, { models: parsed.models });
      return;
    }
    const idx = result.indexOf("[");
    if (idx !== -1) {
      try {
        const arr = JSON.parse(result.slice(idx));
        if (Array.isArray(arr)) {
          sendResponse(state, id, true, { models: arr });
          return;
        }
      } catch {
      }
    }
  } catch (err) {
    log.warn("Failed to list auggie models:", err.message);
  }
  sendResponse(state, id, true, {
    models: [{ id: "default", provider: "auggie", contextWindow: 128e3 }]
  });
}
function handleMessage(state, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    log.warn("Received non-JSON message, ignoring");
    return;
  }
  if (frame.type !== "req") {
    log.debug("Ignoring non-request frame:", frame.type);
    return;
  }
  const { id, method, params } = frame;
  if (!id || !method) {
    log.warn("Request frame missing id or method");
    return;
  }
  log.debug(`Request: ${method} (id=${id})`);
  switch (method) {
    case "connect":
      sendResponse(state, id, true, {
        type: "hello-ok",
        scopes: ["operator.read", "operator.write"]
      });
      break;
    case "chat.send":
      handleChatSend(state, id, params ?? {});
      break;
    case "chat.abort":
      handleChatAbort(state, id, params ?? {});
      break;
    case "sessions.list":
      sendResponse(state, id, true, { sessions: [] });
      break;
    case "sessions.preview":
      sendResponse(state, id, true, { previews: [] });
      break;
    case "models.list":
      void handleModelsList(state, id);
      break;
    default:
      log.warn(`Unknown method: ${method}`);
      sendResponse(state, id, false, {
        code: "unknown_method",
        message: `Unknown method: ${method}`
      });
      break;
  }
}
var dispatchSecret = `at_${Date.now()}_${Math.random().toString(36).slice(2)}`;
var mcpConfigPath = null;
function getMcpServerPath() {
  return (0, import_path.join)(process.cwd(), "lib", "mcp", "agent-town-mcp.mjs");
}
function writeMcpConfig() {
  if (workerRoster.length <= 1) return null;
  if (mcpConfigPath) return mcpConfigPath;
  try {
    const config = {
      mcpServers: {
        "agent-town": {
          command: "node",
          args: [getMcpServerPath()]
        }
      }
    };
    const dir = (0, import_path.join)((0, import_os.tmpdir)(), "agent-town-mcp");
    (0, import_fs.mkdirSync)(dir, { recursive: true });
    const filePath = (0, import_path.join)(dir, `mcp-config-${process.pid}.json`);
    (0, import_fs.writeFileSync)(filePath, JSON.stringify(config), "utf-8");
    mcpConfigPath = filePath;
    log.info(`MCP config written to ${filePath}`);
    return filePath;
  } catch (err) {
    log.warn("Failed to write MCP config:", err.message);
    return null;
  }
}
function cleanupMcpConfig() {
  if (mcpConfigPath) {
    try {
      (0, import_fs.unlinkSync)(mcpConfigPath);
    } catch {
    }
    mcpConfigPath = null;
  }
}
function dispatchToWorker(seatId, task) {
  return new Promise((resolve) => {
    const state = activeClientState;
    const seat = workerRoster.find((w) => w.seatId === seatId);
    if (!state || state.ws.readyState !== import_websocket.default.OPEN) {
      resolve({ result: "", error: "No active WebSocket client" });
      return;
    }
    if (!seat) {
      resolve({ result: "", error: `Unknown seatId: ${seatId}` });
      return;
    }
    const runId = `auggie_sub_${Date.now()}_${++runCounter}`;
    const sessionKey = `subagent:dispatch:${seatId}:${runId}`;
    const prefix = buildPersonalityPrefix({
      seatLabel: seat.label,
      seatRole: seat.roleTitle
    });
    const message = prefix + task;
    sendEvent(state, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "start", label: `${seat.label}: ${task.slice(0, 40)}`, seatId }
    });
    const args = ["--print", "--output-format", "json"];
    const seatSessionKey = `dispatch:${seatId}`;
    const existingSessionId = state.sessionMap.get(seatSessionKey);
    if (existingSessionId) {
      args.push("--resume", existingSessionId);
    }
    args.push("--");
    args.push(message);
    log.info(`Dispatching to ${seat.label} (${seatId}), run ${runId}`);
    let child;
    try {
      child = (0, import_child_process.spawn)("auggie", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
      });
    } catch (err) {
      const errMsg = `Failed to spawn auggie for dispatch: ${err.message}`;
      log.error(errMsg);
      sendEvent(state, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "error", error: errMsg }
      });
      resolve({ result: "", error: errMsg });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      log.error(`dispatch process error for run ${runId}:`, err.message);
      sendEvent(state, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "error", error: err.message }
      });
      resolve({ result: "", error: err.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const errMsg = stderr.trim() || `auggie exited with code ${code}`;
        log.error(`dispatch failed for run ${runId}:`, errMsg);
        sendEvent(state, "agent", {
          runId,
          sessionKey,
          stream: "lifecycle",
          data: { phase: "error", error: errMsg }
        });
        resolve({ result: "", error: errMsg });
        return;
      }
      const parsed = parseAuggieOutput(stdout);
      const responseText = parsed ? typeof parsed.result === "string" ? parsed.result : typeof parsed.response === "string" ? parsed.response : JSON.stringify(parsed) : stdout.trim();
      if (parsed && typeof parsed.session_id === "string") {
        state.sessionMap.set(seatSessionKey, parsed.session_id);
      }
      sendEvent(state, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "end" }
      });
      sendEvent(state, "chat", {
        runId,
        sessionKey,
        state: "final",
        message: { content: [{ type: "text", text: responseText }] }
      });
      log.info(`Dispatch to ${seat.label} completed (run ${runId})`);
      resolve({ result: responseText });
    });
  });
}
function validateDispatchSecret(secret) {
  return secret === dispatchSecret;
}
function setWorkerRoster(seats) {
  workerRoster = seats;
  mcpConfigPath = null;
  log.debug(`Worker roster updated: ${seats.length} workers`);
}
function cleanupClient(state) {
  if (activeClientState === state) activeClientState = null;
  for (const [runId, child] of state.runningProcesses) {
    log.info(`Killing orphaned process for run ${runId}`);
    child.kill("SIGTERM");
  }
  state.runningProcesses.clear();
}
function attachAuggieBridge(server, path = "/api/gateway") {
  const wss = new import_websocket_server.default({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== path) return;
    if (!checkOrigin2(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state = {
        ws,
        seq: 0,
        runningProcesses: /* @__PURE__ */ new Map(),
        sessionMap: /* @__PURE__ */ new Map()
      };
      activeClientState = state;
      log.info("Client connected");
      sendEvent(state, "connect.challenge", {});
      ws.on("message", (data) => {
        handleMessage(state, data.toString());
      });
      ws.on("close", () => {
        log.info("Client disconnected");
        cleanupClient(state);
      });
      ws.on("error", (err) => {
        log.error("Client WS error:", err.message);
        cleanupClient(state);
      });
    });
  });
  wss.on("error", (err) => {
    log.error("WebSocketServer error:", err.message);
  });
  process.on("exit", cleanupMcpConfig);
  log.info(`Auggie bridge attached on ${path}`);
}

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/hermes-bridge.ts
var hermes_bridge_exports = {};
__export(hermes_bridge_exports, {
  attachHermesBridge: () => attachHermesBridge,
  dispatchSecret: () => dispatchSecret2,
  dispatchToWorker: () => dispatchToWorker2,
  setWorkerRoster: () => setWorkerRoster2,
  validateDispatchSecret: () => validateDispatchSecret2
});
var import_child_process2 = require("child_process");
var import_os2 = require("os");

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/hermes-run-api.ts
var import_fs2 = require("fs");
var log2 = createLogger("Hermes API");
var DEFAULT_BASE_URL = "http://127.0.0.1:8642";
var CONFIG_TTL_MS = 5e3;
var cachedConfig = null;
function resolveConfig() {
  const envKey = process.env.HERMES_API_KEY;
  if (envKey) {
    return {
      url: (process.env.HERMES_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
      key: envKey
    };
  }
  const file = process.env.HERMES_API_CONFIG_FILE;
  if (!file) return { url: DEFAULT_BASE_URL, key: "" };
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.config;
  let config = { url: DEFAULT_BASE_URL, key: "" };
  try {
    const parsed = JSON.parse((0, import_fs2.readFileSync)(file, "utf8"));
    if (parsed && typeof parsed.key === "string" && parsed.key) {
      config = {
        url: String(parsed.url || DEFAULT_BASE_URL).replace(/\/+$/, ""),
        key: parsed.key
      };
    }
  } catch {
  }
  cachedConfig = { at: now, config };
  return config;
}
var baseUrl = () => resolveConfig().url;
var apiKey = () => resolveConfig().key;
var isConfigured = () => Boolean(apiKey());
var describe = () => isConfigured() ? `Hermes run API at ${baseUrl()}` : "not configured";
var authHeaders = (extra = {}) => ({
  Authorization: `Bearer ${apiKey()}`,
  ...extra
});
async function health(timeoutMs = 2500) {
  if (!isConfigured()) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/health`, { signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
async function startRun(opts) {
  if (!isConfigured()) return { error: "Hermes API key not configured" };
  const body = { input: opts.input };
  if (opts.sessionId) body.session_id = opts.sessionId;
  if (opts.instructions) body.instructions = opts.instructions;
  try {
    const res = await fetch(`${baseUrl()}/v1/runs`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.run_id) {
      const message = data?.error?.message || `Hermes rejected the run (HTTP ${res.status})`;
      return { error: message };
    }
    return { runId: data.run_id };
  } catch (err) {
    return { error: `Could not reach Hermes: ${err.message}` };
  }
}
async function getRun(runId) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${baseUrl()}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders()
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
async function stopRun(runId) {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(
      `${baseUrl()}/v1/runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST", headers: authHeaders() }
    );
    return res.ok;
  } catch {
    return false;
  }
}
function streamRun(runId, onEvent, onEnd) {
  const ac = new AbortController();
  let finished = false;
  const end = (graceful) => {
    if (finished) return;
    finished = true;
    try {
      onEnd(graceful);
    } catch (err) {
      log2.error("stream onEnd handler failed:", err.message);
    }
  };
  (async () => {
    try {
      const res = await fetch(
        `${baseUrl()}/v1/runs/${encodeURIComponent(runId)}/events`,
        { headers: authHeaders({ Accept: "text/event-stream" }), signal: ac.signal }
      );
      if (!res.ok || !res.body) {
        end(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              onEvent(JSON.parse(raw));
            } catch {
            }
          }
        }
      }
      end(true);
    } catch (err) {
      if (!ac.signal.aborted) {
        log2.debug(`event stream for ${runId} dropped: ${err.message}`);
      }
      end(false);
    }
  })();
  return () => {
    ac.abort();
    end(false);
  };
}

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/lib/hermes-bridge.ts
var log3 = createLogger("Hermes Bridge");
var runCounter2 = 0;
var HERMES_EXE = process.env.HERMES_EXE || (process.platform === "win32" ? "hermes.exe" : "hermes");
var HERMES_CWD = process.env.HERMES_ONESHOT_CWD || (0, import_os2.homedir)();
var CLI_RUN_TIMEOUT_MS = parseInt(process.env.HERMES_ONESHOT_TIMEOUT_MS || "0", 10);
var RUN_RETENTION_MS = 60 * 60 * 1e3;
var MAX_BUFFERED_FRAMES = 400;
var API_PROBE_TTL_MS = 3e4;
var RECONCILE_POLL_MS = 5e3;
var activeClientState2 = null;
var workerRoster2 = [];
var runs = /* @__PURE__ */ new Map();
var sessionIds = /* @__PURE__ */ new Map();
var apiProbe = { at: 0, ok: false };
function sendFrame2(state, frame) {
  if (state.ws.readyState !== import_websocket.default.OPEN) return;
  try {
    state.ws.send(JSON.stringify(frame));
  } catch (err) {
    log3.error("sendFrame failed:", err.message);
  }
}
function sendResponse2(state, id, ok, payloadOrError) {
  const frame = { type: "res", id, ok };
  if (ok) {
    frame.payload = payloadOrError;
  } else {
    frame.error = payloadOrError;
  }
  sendFrame2(state, frame);
}
function emit(record, event, payload) {
  const state = activeClientState2;
  if (state && state.ws.readyState === import_websocket.default.OPEN) {
    sendFrame2(state, { type: "event", event, payload, seq: state.seq++ });
    return;
  }
  if (!record) return;
  if (record.buffered.length >= MAX_BUFFERED_FRAMES) record.buffered.shift();
  record.buffered.push({ type: "event", event, payload });
}
function flushBuffered(state) {
  for (const record of runs.values()) {
    if (record.buffered.length === 0) continue;
    const pending = record.buffered;
    record.buffered = [];
    for (const frame of pending) {
      sendFrame2(state, { ...frame, seq: state.seq++ });
    }
    log3.info(`Replayed ${pending.length} buffered frame(s) for run ${record.runId}`);
  }
}
function checkOrigin3(req, socket) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        log3.warn(`Rejected WS upgrade: origin ${origin} does not match host ${host}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return false;
      }
    } catch {
      log3.warn(`Rejected WS upgrade: invalid origin ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return false;
    }
  }
  return true;
}
function buildWorkerRosterContext2(currentSeatLabel) {
  if (workerRoster2.length <= 1) return "";
  const others = workerRoster2.filter((w) => w.label !== currentSeatLabel);
  if (others.length === 0) return "";
  const lines = others.map((w) => `  \u2022 ${w.label} (${w.roleTitle ?? "Worker"})`);
  return "\n\nYour teammates in this office:\n" + lines.join("\n") + "\n";
}
function buildPersonalityPrefix2(params) {
  const label = params.seatLabel;
  const role = params.seatRole;
  if (!label && !role) {
    return "[You are a worker in Agent Town, powered by Hermes. Stay in character.]\n\n";
  }
  const parts = [];
  if (label) parts.push(`Your name is "${label}".`);
  if (role) parts.push(`Your role is ${role}.`);
  parts.push("Stay in character when responding.");
  const rosterCtx = buildWorkerRosterContext2(label);
  return `[${parts.join(" ")}${rosterCtx}]

`;
}
function createRun(runId, engine, sessionKey) {
  const record = {
    runId,
    engine,
    sessionKey,
    startedAt: Date.now(),
    status: "running",
    buffered: [],
    waiters: []
  };
  runs.set(runId, record);
  return record;
}
function waitForTerminal(record) {
  if (record.status !== "running") return Promise.resolve();
  return new Promise((resolve) => record.waiters.push(resolve));
}
function sweepFinishedRuns() {
  const cutoff = Date.now() - RUN_RETENTION_MS;
  for (const [runId, record] of runs) {
    if (record.status !== "running" && (record.finishedAt ?? 0) < cutoff) {
      runs.delete(runId);
    }
  }
}
function finishRun(record, outcome, detail) {
  if (record.status !== "running") return;
  record.status = outcome;
  record.finishedAt = Date.now();
  record.result = detail.result;
  record.error = detail.error;
  record.child = void 0;
  try {
    record.detach?.();
  } catch {
  }
  record.detach = void 0;
  const { runId, sessionKey } = record;
  if (outcome === "stopped") {
    emit(record, "chat", { runId, sessionKey, state: "aborted" });
    log3.info(`Run ${runId} stopped`);
  } else if (outcome === "failed") {
    const message = detail.error || "The agent could not finish the task.";
    emit(record, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: { phase: "error", error: message }
    });
    emit(record, "chat", { runId, sessionKey, state: "error", error: message });
    log3.error(`Run ${runId} failed: ${message}`);
  } else {
    emit(record, "agent", { runId, sessionKey, stream: "lifecycle", data: { phase: "end" } });
    emit(record, "chat", {
      runId,
      sessionKey,
      state: "final",
      message: { content: [{ type: "text", text: detail.result || "(no output)" }] }
    });
    log3.info(`Run ${runId} completed in ${Math.round((record.finishedAt - record.startedAt) / 1e3)}s`);
  }
  const waiters = record.waiters;
  record.waiters = [];
  for (const wake of waiters) {
    try {
      wake();
    } catch {
    }
  }
  sweepFinishedRuns();
}
async function apiAvailable() {
  if (!isConfigured()) return false;
  const now = Date.now();
  if (now - apiProbe.at < API_PROBE_TTL_MS) return apiProbe.ok;
  const ok = await health();
  apiProbe = { at: now, ok };
  if (!ok) log3.warn("Hermes run API is not answering; falling back to the CLI engine.");
  return ok;
}
function sessionIdFor(sessionKey) {
  const existing = sessionIds.get(sessionKey);
  if (existing) return existing;
  const slug = sessionKey.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 48) || "seat";
  const id = `agenttown_${slug}_${Math.random().toString(36).slice(2, 8)}`;
  sessionIds.set(sessionKey, id);
  return id;
}
function handleApiEvent(record, event) {
  const { runId, sessionKey } = record;
  switch (event.event) {
    case "tool.started":
      emit(record, "agent", {
        runId,
        sessionKey,
        stream: "tool",
        data: { name: event.tool, input: event.preview }
      });
      return;
    case "tool.completed":
      emit(record, "agent", {
        runId,
        sessionKey,
        stream: "tool",
        data: { name: event.tool, output: event.error ? "error" : `done in ${event.duration}s` }
      });
      return;
    case "message.delta":
      if (event.delta) {
        emit(record, "agent", {
          runId,
          sessionKey,
          stream: "assistant",
          data: { delta: event.delta }
        });
      }
      return;
    case "run.completed":
      finishRun(record, "completed", { result: event.output || "" });
      return;
    case "run.failed":
      finishRun(record, "failed", {
        error: typeof event.error === "string" ? event.error : "The agent reported a failure."
      });
      return;
    case "run.cancelled":
      finishRun(record, "stopped", {});
      return;
    default:
      return;
  }
}
async function startApiRun(sessionKey, message, instructions) {
  const started = await startRun({
    input: message,
    sessionId: sessionIdFor(sessionKey),
    instructions
  });
  if ("error" in started) return started;
  const record = createRun(started.runId, "api", sessionKey);
  emit(record, "agent", {
    runId: record.runId,
    sessionKey,
    stream: "lifecycle",
    data: { phase: "start" }
  });
  record.detach = streamRun(
    record.runId,
    (event) => handleApiEvent(record, event),
    (graceful) => {
      if (record.status !== "running") return;
      if (graceful) {
        void reconcileRun(record);
      } else {
        log3.warn(`Event stream for ${record.runId} dropped; reconciling via status poll.`);
        setTimeout(() => void reconcileRun(record), 1500);
      }
    }
  );
  return { runId: record.runId };
}
async function reconcileRun(record) {
  if (record.status !== "running") return;
  const status = await getRun(record.runId);
  if (!status) {
    finishRun(record, "failed", {
      error: "Lost contact with Hermes while the agent was working."
    });
    return;
  }
  if (status.status === "completed") {
    finishRun(record, "completed", { result: status.output || "" });
    return;
  }
  if (status.status === "failed") {
    finishRun(record, "failed", { error: status.error || "The agent reported a failure." });
    return;
  }
  if (status.status === "cancelled") {
    finishRun(record, "stopped", {});
    return;
  }
  if (!record.polling) {
    record.polling = true;
    log3.info(`Run ${record.runId} is still ${status.status}; following it by status poll.`);
  }
  setTimeout(() => void reconcileRun(record), RECONCILE_POLL_MS);
}
function parseSessionId(stderr) {
  const m = /session_id:\s*(\S+)/i.exec(stderr);
  return m ? m[1] : void 0;
}
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      (0, import_child_process2.spawn)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
  }
}
function runHermesCli(record, message, resumeId) {
  return new Promise((resolve) => {
    const args = ["chat", "-q", message, "-Q"];
    if (resumeId) args.push("--resume", resumeId);
    let child;
    try {
      child = (0, import_child_process2.spawn)(HERMES_EXE, args, {
        cwd: HERMES_CWD,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Non-interactive: auto-approve tool/shell prompts so the run never
        // hangs waiting for a TTY (same policy Hermes' own oneshot mode uses).
        env: { ...process.env, HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" }
      });
    } catch (err) {
      resolve({ text: "", error: `Failed to launch Hermes: ${err.message}` });
      return;
    }
    record.child = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (record.child === child) record.child = void 0;
      resolve(result);
    };
    if (CLI_RUN_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        killTree(child);
        settle({
          text: "",
          error: `Hermes exceeded the configured ${Math.round(CLI_RUN_TIMEOUT_MS / 1e3)}s limit`
        });
      }, CLI_RUN_TIMEOUT_MS);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle({ text: "", error: `Hermes process error: ${err.message} (is Hermes installed?)` });
    });
    child.on("close", (code) => {
      const text = stdout.trim();
      const sessionId = parseSessionId(stderr);
      if (code === 0) {
        settle({ text, sessionId });
        return;
      }
      const resumeFailed = Boolean(resumeId) && /not found|no session|session .*not/i.test(stderr);
      const errTail = (stderr.trim().split(/\r?\n/).filter(Boolean).pop() || "").slice(0, 300);
      settle({
        text,
        sessionId,
        resumeFailed,
        error: text ? void 0 : errTail || `hermes exited with code ${code}`
      });
    });
  });
}
async function runCliTask(record, rawMessage, personaPrefix) {
  const { sessionKey } = record;
  emit(record, "agent", {
    runId: record.runId,
    sessionKey,
    stream: "lifecycle",
    data: { phase: "start" }
  });
  let resumeId = sessionIds.get(sessionKey);
  const firstTurnMessage = personaPrefix + rawMessage;
  let result = await runHermesCli(record, resumeId ? rawMessage : firstTurnMessage, resumeId);
  if (result.resumeFailed && resumeId && record.status === "running") {
    log3.warn(`Resume ${resumeId} failed for ${sessionKey}; starting a fresh session`);
    sessionIds.delete(sessionKey);
    resumeId = void 0;
    result = await runHermesCli(record, firstTurnMessage, void 0);
  }
  if (result.sessionId) sessionIds.set(sessionKey, result.sessionId);
  if (record.status === "stopped") return;
  if (result.error && !result.text) {
    finishRun(record, "failed", { error: result.error });
    return;
  }
  finishRun(record, "completed", { result: result.text });
}
async function handleChatSend2(state, id, params) {
  const sessionKey = params.sessionKey ?? "default";
  const rawMessage = params.message ?? "";
  const persona = buildPersonalityPrefix2(params);
  if (await apiAvailable()) {
    const started = await startApiRun(sessionKey, rawMessage, persona.trim());
    if ("error" in started) {
      log3.warn(`Run API refused the task (${started.error}); using the CLI engine instead.`);
      apiProbe = { at: Date.now(), ok: false };
    } else {
      sendResponse2(state, id, true, { runId: started.runId, status: "accepted" });
      log3.info(`chat.send \u2192 Hermes /v1/runs (run ${started.runId}, session ${sessionKey})`);
      return;
    }
  }
  const runId = `hermes_${Date.now()}_${++runCounter2}`;
  sendResponse2(state, id, true, { runId, status: "accepted" });
  const record = createRun(runId, "cli", sessionKey);
  log3.info(
    `chat.send \u2192 hermes chat -q (run ${runId}, session ${sessionKey}, ${sessionIds.get(sessionKey) ? "resume" : "new"})`
  );
  void runCliTask(record, rawMessage, persona);
}
async function handleChatAbort2(state, id, params) {
  const runId = params.runId;
  const record = runId ? runs.get(runId) : void 0;
  sendResponse2(state, id, true, {});
  if (!runId || !record || record.status !== "running") return;
  if (record.engine === "api") {
    await stopRun(runId);
    finishRun(record, "stopped", {});
  } else {
    if (record.child) killTree(record.child);
    finishRun(record, "stopped", {});
  }
  log3.info(`Aborted run ${runId}`);
}
function handleMessage2(state, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    log3.warn("Received non-JSON message, ignoring");
    return;
  }
  if (frame.type !== "req") return;
  const { id, method, params } = frame;
  if (!id || !method) {
    log3.warn("Request frame missing id or method");
    return;
  }
  switch (method) {
    case "connect":
      sendResponse2(state, id, true, {
        type: "hello-ok",
        scopes: ["operator.read", "operator.write"]
      });
      flushBuffered(state);
      break;
    case "chat.send":
      void handleChatSend2(state, id, params ?? {});
      break;
    case "chat.abort":
      void handleChatAbort2(state, id, params ?? {});
      break;
    case "sessions.list":
      sendResponse2(state, id, true, { sessions: [] });
      break;
    case "sessions.preview":
      sendResponse2(state, id, true, { previews: [] });
      break;
    case "models.list":
      sendResponse2(state, id, true, {
        models: [{ id: "hermes", provider: "hermes", contextWindow: 2e5 }]
      });
      break;
    default:
      log3.warn(`Unknown method: ${method}`);
      sendResponse2(state, id, false, {
        code: "unknown_method",
        message: `Unknown method: ${method}`
      });
      break;
  }
}
var dispatchSecret2 = `ht_${Date.now()}_${Math.random().toString(36).slice(2)}`;
async function dispatchToWorker2(seatId, task) {
  const seat = workerRoster2.find((w) => w.seatId === seatId);
  if (!seat) {
    return { result: "", error: `Unknown seatId: ${seatId}` };
  }
  const persona = buildPersonalityPrefix2({ seatLabel: seat.label, seatRole: seat.roleTitle });
  const suffix = `${Date.now()}_${++runCounter2}`;
  const sessionKey = `subagent:dispatch:${seatId}:${suffix}`;
  const mapKey = `dispatch:${seatId}`;
  const emitStart = (record2) => emit(record2, "agent", {
    runId: record2.runId,
    sessionKey,
    stream: "lifecycle",
    data: { phase: "start", label: `${seat.label}: ${task.slice(0, 40)}`, seatId }
  });
  if (await apiAvailable()) {
    const started = await startRun({
      input: task,
      sessionId: sessionIdFor(mapKey),
      instructions: persona.trim()
    });
    if (!("error" in started)) {
      const record2 = createRun(started.runId, "api", sessionKey);
      emitStart(record2);
      record2.detach = streamRun(
        started.runId,
        (event) => handleApiEvent(record2, event),
        (graceful) => {
          setTimeout(() => void reconcileRun(record2), graceful ? 0 : 1500);
        }
      );
      await waitForTerminal(record2);
      return record2.status === "completed" ? { result: record2.result || "" } : { result: "", error: record2.error || "the run did not complete" };
    }
    log3.warn(`Run API refused the dispatch (${started.error}); using the CLI engine instead.`);
    apiProbe = { at: Date.now(), ok: false };
  }
  const runId = `hermes_sub_${suffix}`;
  const record = createRun(runId, "cli", sessionKey);
  emitStart(record);
  let resumeId = sessionIds.get(mapKey);
  let result = await runHermesCli(record, resumeId ? task : persona + task, resumeId);
  if (result.resumeFailed && resumeId) {
    sessionIds.delete(mapKey);
    resumeId = void 0;
    result = await runHermesCli(record, persona + task, void 0);
  }
  if (result.sessionId) sessionIds.set(mapKey, result.sessionId);
  if (result.error && !result.text) {
    finishRun(record, "failed", { error: result.error });
    return { result: "", error: result.error };
  }
  finishRun(record, "completed", { result: result.text });
  return { result: result.text };
}
function validateDispatchSecret2(secret) {
  return secret === dispatchSecret2;
}
function setWorkerRoster2(seats) {
  workerRoster2 = seats;
  log3.debug(`Worker roster updated: ${seats.length} workers`);
}
var shutdownHooked = false;
function hookShutdown() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const reap = () => {
    for (const record of runs.values()) {
      if (record.child) {
        log3.info(`Killing orphaned process for run ${record.runId}`);
        killTree(record.child);
      }
      try {
        record.detach?.();
      } catch {
      }
    }
  };
  process.once("exit", reap);
  process.once("SIGINT", () => {
    reap();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    reap();
    process.exit(0);
  });
}
function attachHermesBridge(server, path = "/api/gateway") {
  const wss = new import_websocket_server.default({ noServer: true });
  hookShutdown();
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== path) return;
    if (!checkOrigin3(req, socket)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state = { ws, seq: 0 };
      activeClientState2 = state;
      log3.info("Client connected");
      sendFrame2(state, { type: "event", event: "connect.challenge", payload: {}, seq: state.seq++ });
      ws.on("message", (data) => handleMessage2(state, data.toString()));
      ws.on("close", () => {
        log3.info("Client disconnected (running tasks continue)");
        if (activeClientState2 === state) activeClientState2 = null;
      });
      ws.on("error", (err) => {
        log3.error("Client WS error:", err.message);
        if (activeClientState2 === state) activeClientState2 = null;
      });
    });
  });
  wss.on("error", (err) => {
    log3.error("WebSocketServer error:", err.message);
  });
  const engine = isConfigured() ? `${describe()} (CLI fallback: ${HERMES_EXE})` : `Hermes CLI (${HERMES_EXE}) \u2014 run API not configured yet, will be picked up when it is`;
  log3.info(`Hermes bridge attached on ${path} \u2014 engine: ${engine}`);
}

// ../../../AppData/Local/Temp/knockdesk-agent-town-build/server.ts
var log4 = createLogger("Server");
var dev = process.env.NODE_ENV !== "production";
var port = parseInt(process.env.PORT ?? "3000", 10);
var GATEWAY_URL = process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789/";
var AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "openclaw";
process.env.NEXT_PUBLIC_AGENT_PROVIDER = AGENT_PROVIDER;
var bridge = AGENT_PROVIDER === "hermes" ? hermes_bridge_exports : AGENT_PROVIDER === "auggie" ? auggie_bridge_exports : null;
var app = (0, import_next.default)({ dev, webpack: dev });
var handle = app.getRequestHandler();
function handleDispatch(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  const remoteIp = req.socket.remoteAddress;
  if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  const secret = req.headers["x-dispatch-secret"];
  if (!bridge || !secret || !bridge.validateDispatchSecret(secret)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid dispatch secret" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { seatId, task } = JSON.parse(body);
      if (!seatId || !task) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "seatId and task are required" }));
        return;
      }
      bridge.dispatchToWorker(seatId, task).then((result) => {
        res.writeHead(result.error ? 500 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}
function handleSeatSync(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { seats } = JSON.parse(body);
      if (Array.isArray(seats) && bridge) {
        bridge.setWorkerRoster(
          seats.filter((s) => s.assigned).map((s) => ({
            seatId: s.seatId,
            label: s.label,
            roleTitle: s.roleTitle
          }))
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
}
app.prepare().then(() => {
  const server = (0, import_http.createServer)((req, res) => {
    if (bridge) {
      if (req.url === "/api/internal/dispatch") {
        handleDispatch(req, res);
        return;
      }
      if (req.url === "/api/internal/seat-sync") {
        handleSeatSync(req, res);
        return;
      }
    }
    handle(req, res);
  });
  if (AGENT_PROVIDER === "hermes") {
    attachHermesBridge(server);
    log4.info(`Ready on http://localhost:${port}`);
    log4.info(`Provider: Hermes (bridging via hermes -z CLI)`);
  } else if (AGENT_PROVIDER === "auggie") {
    attachAuggieBridge(server);
    log4.info(`Ready on http://localhost:${port}`);
    log4.info(`Provider: Auggie (bridging via auggie CLI)`);
  } else {
    attachWsProxy(server, GATEWAY_URL);
    log4.info(`Ready on http://localhost:${port}`);
    log4.info(`Gateway proxy: ws://localhost:${port}/api/gateway \u2192 ${GATEWAY_URL}`);
  }
  server.listen(port);
}).catch((err) => {
  log4.error("Failed to prepare Next.js:", err);
  process.exit(1);
});
