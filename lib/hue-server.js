"use strict";
var nodeHueApi = require('node-hue-api');
var _          = require('lodash');
var LightItem  = require('./hue-light.js');

var inherits      = require('util').inherits;
var EventEmitter  = require('events').EventEmitter;

/**
 * Create light/group id from HUE info
 * @param  {object}  hueInfo HUE info
 * @param  {boolean} isLight Light or Group ID
 * @return {string} ID
 */
function createLightID(hueInfo, isLight) {
  return `${isLight?'light':'group'}${hueInfo.id}`;
}


/**
 * Light handler handles communication between server and client
 * @param {string}      lightID     Light ID to set and get changes from
 * @param {LightServer} lightServer Server object
 */
function LightHandler(lightID, lightServer) {
  this.id = lightID;
  this.lightServer = lightServer;
  EventEmitter.call(this);
}
inherits(LightHandler, EventEmitter);


/**
 * Set state of light
 * @param  {object}  data New light data
 * @return {boolean}      False if there is no such light or it's not discovered yet
 */
LightHandler.prototype.setLightState = function setState(data) {
  return this.lightServer.setLightState(this.id, data);
};


/**
 * Send data to light
 * @param  {object} data New light data
 * @return {object}      Light state, null if there is no such light
 */
LightHandler.prototype.getLightState = function getLightState() {
  return this.lightServer.getLightState(this.id);
};


/**
 * Used to emit that this light has been found
 * @param  {object} data Light information
 */
LightHandler.prototype.emitNew = function emitNew(data) {
  this.emit('new', data);
}


/**
 * Used to emit that the light has been updated
 * @param  {object} data Light information
 */
LightHandler.prototype.emitUpdate = function emitUpdate(data) {
  this.emit('update', data);
};


/**
 * Server handling all lights
 * @class  LightServer
 * @param {object} config Configuration
 */
function LightServer(config) {
  EventEmitter.call(this);

  var self = this;

  self.config = _.merge({}, config);

  // Convert from string
  if (typeof self.config.interval === 'string')
    self.config.interval = parseInt(self.config.interval, 10);
  
  // Ensure that we have valid poll interval
  if (typeof self.config.interval !== 'number' || isNaN(self.config.interval))
    self.config.interval = 10000;
  // Ensure that we don't use to low poll interval
  else if (self.config.interval < 500)
    self.config.interval = 500;

  // List of all registerd nodes
  this.nodeList = {};
  this.nodeListCount = 0;

  // List of all lights
  this.lights = {};

  // Create new API
  this.hueApi = new nodeHueApi.HueApi(this.config.address, this.config.key);

  // Create wrapper function for setLightState
  this.hueApiSetLightState = function setLightState(id, state) {
    self.hueApi.setLightState(id, state, function(err) {
      if (err)
        self.emit('warning', err.toString());
    });
  };

  // Create wrapper function for setGroupLightState
  this.hueApiSetGroupLightState = function setGroupLightState(id, state) {
    self.hueApi.setGroupLightState(id, state, function(err) {
      if (err)
        self.emit('warning', err.toString());
    });
  };

  this.lightPollInterval = null;

  // Manually initiate polling to detect all lights
  this.pollChanges((err) => {
    if (err) {
      self.emit('warning', err.toString());
      return;
    }

    /**
     * Function to ignore all errors for poll function
     */
    function ignorePollResult() {
    }

    // Only start poll after successfully got all lights, bind to function that ignores all erros
    self.lightPollInterval = setInterval(self.pollChanges.bind(self, ignorePollResult), self.config.interval);
  });

}

inherits(LightServer, EventEmitter);


/**
 * Poll Bridge for changes
 * @param  {function} callback Done callback
 */
LightServer.prototype.pollChanges = function pollChanges(callback) {
  var self = this;

  /**
   * Process list of Lights or Groups
   * @param  {array}  list    List
   * @param  {boolean} isLight Lights or Groups
   */
  function processItems(list, isLight) {
    list.forEach((hueInfo) => {
      // Ignore group 0
      if (!isLight && hueInfo.id === '0')
        return;

      var lightID = createLightID(hueInfo, isLight);

      // New light found
      if (!self.lights.hasOwnProperty(lightID)) {
        self.newLight(lightID, hueInfo, isLight);
        return;
      }

      // Update info for existing light
      var hueLight = self.lights[lightID];
      hueLight.updateInfo(hueInfo);
    });
  }

  // First request lights information
  this.hueApi.lights((lightsErr, lightsInfo) => {
    if (lightsErr)
      return callback(lightsErr);

    // Then request groups information
    this.hueApi.groups((groupErr, groupInfo) => {
      if (groupErr)
        return callback(groupErr);

      // Process both lists
      processItems(lightsInfo.lights, true);
      processItems(groupInfo, false);
    
      callback(null);
    });
  });
}

/**
 * Stop the server
 */
LightServer.prototype.stop = function stop() {
  var self = this;
  if (this.lightPollInterval !== null)
    clearInterval(this.lightPollInterval);
  this.lightPollInterval = null;

  // Stop and remove lights
  Object.keys(this.lights).forEach((lightID) => {
    var light = self.lights[lightID];
    light.stop();
  });
  this.lights = {};
}


/**
 * Create new light for the server
 * @param {string}  lightID  ID for light/group
 * @param {object}  hueInfo  Hue info
 * @param {boolean} isLight  Light or group
 */
LightServer.prototype.newLight = function newLight(lightID, hueInfo, isLight) {
  var self = this;
  
  var light = new LightItem(lightID, hueInfo, isLight);
  var apiFunc = isLight ? this.hueApiSetLightState : this.hueApiSetGroupLightState;

  light.on('error', (msg, obj) => {
    self.emit('error', msg, obj);
  });

  light.on('warning', (msg, obj) => {
    self.emit('warning', msg, obj);
  });

  light.on('change', () => {
    self.statusUpdateLight(lightID, light, 'change');
  });

  light.on('update', () => {
    self.statusUpdateLight(lightID, light, 'update');
  })

  // Pass new state to Hue api to update the light
  light.on('sendToLight', (hueID, newState) => {
    apiFunc(hueID, newState);
  });

  // Attach the light
  self.lights[lightID] = light;

  // Current state message, mark it as new
  let message = light.getStateMessage();
  message.event = 'new';

  // Check if anybody has registered for this light, need to tell them about this new light
  if (self.nodeList.hasOwnProperty(lightID)) {
    let lightHandler = this.nodeList[lightID];

    lightHandler.emitNew(message);
  }

  // Emit light-new from the server to allow listeners to see the new light
  self.emit('light-new', message);
}


/**
 * Using light find all connected nodes and update state for them
 * @param {string} lightID  ID for light/group
 * @param {object} light    HUE light
 * @param {string} event    Event triggering this update
 */
LightServer.prototype.statusUpdateLight = function statusUpdateLight(lightID, light, event) {
  if (!this.nodeList.hasOwnProperty(lightID))
    return;

  let lightHandler = this.nodeList[lightID];

  let message = light.getStateMessage();
  message.event = event;

  lightHandler.emitUpdate(message);
};


/**
 * Get light handle that communicates between server and client
 * @param  {string}       lightID ID/Label of the light
 * @return {LightHandler}         Light handler object, emit change events from light and receive new state
 */
LightServer.prototype.getLightHandler = function getLightHandler(lightID) {
  var lightHandler;

  // Create new light handler if needed
  if (!this.nodeList.hasOwnProperty(lightID)) {
    this.nodeList[lightID] = new LightHandler(lightID, this);
  }

  lightHandler = this.nodeList[lightID];

  return lightHandler;
};


/**
 * Change light state
 * @param  {string} lightID ID/Label for the light
 * @param  {object} value   New values for the light
 * @return {boolean}        False if no such light exists
 */
LightServer.prototype.setLightState = function setLightState(lightID, value) {
  if (!this.lights.hasOwnProperty(lightID))
    return false;

  var light = this.lights[lightID];

  // Update light color
  light.setColor(value);
  return true;
}


/**
 * Get current light state
 * @param  {string} lightID ID/Label for the light
 * @return {object} null if the light doesn't exists, else the current light state
 */
LightServer.prototype.getLightState = function getLightState(lightID) {
  if (!this.lights.hasOwnProperty(lightID))
    return null;

  var light = this.lights[lightID];
  return light.getStateMessage();
}


/**
 * Retreive list of detected lights
 * @return {array} Array with id, address and label for each light
 */
LightServer.prototype.getLights = function getLights() {
  var self = this;
  var retVal = {
    lights: [],
    groups: [],
  }

  Object.keys(self.lights).forEach((lightID) => {
    var light = self.lights[lightID];
    var val = { id: lightID, hueID: light.info.id, name: light.info.name };
    if (light.isLight)
      retVal.lights.push(val);
    else
      retVal.groups.push(val);
  });

  return retVal;
 }


module.exports = LightServer;
