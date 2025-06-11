'use strict';

import { configParser, http, PullTimer, notifications, Cache, utils, MQTTClient } from 'homebridge-http-utils';

import PACKAGE_JSON from '../package.json';

import type { API, Logging } from 'homebridge';

const MANUFACTURER: string = PACKAGE_JSON.author.name;
const SERIAL_NUMBER = '001';
const MODEL: string = PACKAGE_JSON.name;
const FIRMWARE_REVISION: string = PACKAGE_JSON.version;

let Service: any, Characteristic: any;

type HttpLightConfig = {
  name: string;
  power?: any;
  onUrl?: any;
  offUrl?: any;
  statusUrl?: any;
  statusCache?: number;
  brightness?: any;
  brightnessCache?: number;
  hue?: any;
  hueCache?: number;
  saturation?: any;
  saturationCache?: number;
  colorTemperature?: any;
  colorTemperatureCache?: number;
  auth?: {
    username?: string;
    password?: string;
  };
  pullInterval?: number;
  notificationID?: string;
  notificationPassword?: string;
  mqtt?: any;
};

const BrightnessUnit = Object.freeze({
  PERCENT: 'percent',
  RGB: 'rgb',
});

const HueUnit = Object.freeze({
  HSV: 'hsv',
  ZIGBEE: 'zigbee',
});

const SaturationUnit = Object.freeze({
  PERCENT: 'percent',
  RGB: 'rgb',
});

const TemperatureUnit = Object.freeze({
  MICRORECIPROCAL_DEGREE: 'mired',
  KELVIN: 'kelvin',
});

/*
 * Describes the current color mode of the light.
 * This is only important when using Hue, Saturation and ColorTemperature characteristics together. If so the values
 * of the characteristics need to be synced up. When setting color temperature the Hue and Saturation characteristics
 * need to correctly represent the current color temperature via HSV otherwise the Home App gets a bit glitchy.
 */
const ColorMode = Object.freeze({
  UNDEFINED: 'undefined',
  COLOR: 'color',
  TEMPERATURE: 'temperature',
});

// Use export default for ESM compatibility
const plugin = (api: API) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  // Register using a wrapper to adapt Homebridge's AccessoryConfig to our HttpLightbulbConfig
  api.registerAccessory(MODEL, 'HTTP-LIGHTBULB', class extends HttpLightbulb {
    constructor(log: Logging, config: any, api: API) {
      // Optionally, validate config here or map fields as needed
      super(log, config as HttpLightConfig, api);
    }
  });
};

class HttpLightbulb {
  log: Logging;
  name: string;
  colorMode: string;
  adaptiveLightingSupport: boolean;
  adaptiveLightingController: any;
  statusCache: any;
  brightnessCache: any;
  hueCache: any;
  saturationCache: any;
  colorTemperatureCache: any;
  power: any;
  brightness: any;
  hue: any;
  saturation: any;
  colorTemperature: any;
  withholdPowerCall: boolean = false;
  pullTimer: any;
  pullInterval: number | undefined;
  mqttClient: any;
  homebridgeService: any;
  api: API;
  auth?: {
    username?: string;
    password?: string;
  };

  constructor(log: Logging, config: HttpLightConfig, api: API) {
    this.log = log;
    this.name = config.name;
    this.api = api;

    this.colorMode = ColorMode.UNDEFINED;

    this.adaptiveLightingSupport = this.checkAdaptiveLightingSupport(api);

    const success = this.parseCharacteristics(config);
    if (!success) {
      this.log.warn('Aborting...');
      return;
    }

    this.statusCache = new Cache(config.statusCache, 0);
    this.brightnessCache = new Cache(config.brightnessCache, 0);
    this.hueCache = new Cache(config.hueCache, 0);
    this.saturationCache = new Cache(config.saturationCache, 0);
    this.colorTemperatureCache = new Cache(config.colorTemperatureCache, 0);

    if (config.statusCache && typeof config.statusCache !== 'number') {
      this.log.warn('Property \'statusCache\' was given in an unsupported type. Using default one!');
    }
    if (config.brightnessCache && typeof config.brightnessCache !== 'number') {
      this.log.warn('Property \'brightnessCache\' was given in an unsupported type. Using default one!');
    }
    if (config.hueCache && typeof config.hueCache !== 'number') {
      this.log.warn('Property \'hueCache\' was given in an unsupported type. Using default one!');
    }
    if (config.saturationCache && typeof config.saturationCache !== 'number') {
      this.log.warn('Property \'saturationCache\' was given in an unsupported type. Using default one!');
    }
    if (config.colorTemperatureCache && typeof config.colorTemperatureCache !== 'number') {
      this.log.warn('Property \'colorTemperatureCache\' was given in an unsupported type. Using default one!');
    }

    if (config.auth) {
      if (!(config.auth.username && config.auth.password)) {
        this.log.warn('\'auth.username\' and/or \'auth.password\' was not set!');
      } else {
        const urlObjects = [this.power.onUrl, this.power.offUrl, this.power.statusUrl];
        if (this.brightness) {
          urlObjects.push(this.brightness.setUrl, this.brightness.statusUrl);
        }
        if (this.hue) {
          urlObjects.push(this.hue.setUrl, this.hue.statusUrl);
        }
        if (this.saturation) {
          urlObjects.push(this.saturation.setUrl, this.saturation.statusUrl);
        }
        if (this.colorTemperature) {
          urlObjects.push(this.colorTemperature.setUrl, this.colorTemperature.statusUrl);
        }

        urlObjects.forEach(value => {
          if (value && value.auth && config.auth) {
            value.auth.username = config.auth.username;
            value.auth.password = config.auth.password;
          }
        })
      }
    }

    this.homebridgeService = new Service.Lightbulb(this.name);

    // Register characteristic handlers here, after this.power is initialized
    this.homebridgeService
      .getCharacteristic(Characteristic.On)
      .onGet(this.getPowerState.bind(this))
      .onSet(this.setPowerState.bind(this));
    if (this.brightness) {
      this.homebridgeService
        .getCharacteristic(Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    }
    if (this.hue) {
      this.homebridgeService
        .getCharacteristic(Characteristic.Hue)
        .onGet(this.getHue.bind(this))
        .onSet(this.setHue.bind(this));
    }
    if (this.saturation) {
      this.homebridgeService
        .getCharacteristic(Characteristic.Saturation)
        .onGet(this.getSaturation.bind(this))
        .onSet(this.setSaturation.bind(this));
    }
    if (this.colorTemperature) {
      this.homebridgeService
        .getCharacteristic(Characteristic.ColorTemperature)
        .onGet(this.getColorTemperature.bind(this))
        .onSet(this.setColorTemperature.bind(this))
        .setProps({
          minValue: this.colorTemperature.minValue,
          maxValue: this.colorTemperature.maxValue,
        });
    }

    if (this.adaptiveLightingSupport && this.brightness && this.colorTemperature) {
      this.adaptiveLightingController = new api.hap.AdaptiveLightingController(this.homebridgeService);
    }

    /** @namespace config.mqtt */
    if (config.mqtt) {
      let options: any;
      try {
        options = configParser.parseMQTTOptions(config.mqtt);
      } catch (error: any) {
        this.log.error('Error occurred while parsing MQTT property: ' + error.message);
        this.log.error('MQTT will not be enabled!');
      }

      if (options) {
        try {
          this.mqttClient = new MQTTClient(this.homebridgeService, options, this.log);
          this.mqttClient.connect();
        } catch (error: any) {
          this.log.error('Error occurred creating mqtt client: ' + error.message);
        }
      }
    }

    if (this.power.isMqtt) {
      if (!this.mqttClient) {
        this.log.warn('MQTT topics where specified however no mqtt client could be established. Is the \'mqtt\' property specified?');
        return;
      }

      this.mqttClient.subscribe(this.power.getTopic, 'On');
    }

    if (this.mqttClient) {
      this.mqttClient.on('message-On', this.handleMQTTMessage.bind(this));
      if (this.brightness) {
        this.mqttClient.on('message-Brightness', this.handleMQTTMessage.bind(this));
      }
      if (this.hue) {
        this.mqttClient.on('message-Hue', this.handleMQTTMessage.bind(this));
      }
      if (this.saturation) {
        this.mqttClient.on('message-Saturation', this.handleMQTTMessage.bind(this));
      }
      if (this.colorTemperature) {
        this.mqttClient.on('message-ColorTemperature', this.handleMQTTMessage.bind(this));
      }
    }

    this.pullInterval = config.pullInterval;

    if (this.pullInterval) {
      this.pullTimer = new PullTimer(
        log,
        this.pullInterval,
        async () => {
          const value = await this.getPowerState();
          this.homebridgeService.updateCharacteristic(Characteristic.On, value);
          if (this.brightness) {
            const brightness = await this.getBrightness();
            this.homebridgeService.updateCharacteristic(Characteristic.Brightness, brightness);
          }
          if (this.hue && this.colorMode === ColorMode.COLOR) {
            const hue = await this.getHue();
            this.homebridgeService.updateCharacteristic(Characteristic.Hue, hue);
          }
          if (this.saturation && this.colorMode === ColorMode.COLOR) {
            const saturation = await this.getSaturation();
            this.homebridgeService.updateCharacteristic(Characteristic.Saturation, saturation);
          }
          if (this.colorTemperature && this.colorMode === ColorMode.TEMPERATURE) {
            const colorTemperature = await this.getColorTemperature();
            this.homebridgeService.updateCharacteristic(Characteristic.ColorTemperature, colorTemperature);
          }
        },
        undefined,
      );
      this.pullTimer.start();
    }

    /** @namespace config.notificationID */
    /** @namespace config.notificationPassword */
    if (typeof config.notificationID === 'string' && config.notificationID.length > 0) {
      notifications.enqueueNotificationRegistrationIfDefined(
        api,
        log,
        config.notificationID ?? '',
        config.notificationPassword ?? '',
        this.handleNotification.bind(this),
      );
    }

    this.log.info('Lightbulb successfully configured...');
    this.log.debug('Lightbulb started with the following options: ');
    this.log.debug('  - power: ' + JSON.stringify(this.power));
    if (this.brightness) {
      this.log.debug('  - brightness: ' + JSON.stringify(this.brightness));
    }
    if (this.hue) {
      this.log.debug('  - hue: ' + JSON.stringify(this.hue));
    }
    if (this.saturation) {
      this.log.debug('  - saturation: ' + JSON.stringify(this.saturation));
    }
    if (this.colorTemperature) {
      this.log.debug('  - colorTemperature: ' + JSON.stringify(this.colorTemperature));
    }

    if (this.auth) {
      this.log.debug('  - auth options: ' + JSON.stringify(this.auth));
    }

    if (this.pullTimer) {
      this.log.debug('  - pullTimer started with interval ' + config.pullInterval);
    }

    if (config.notificationID) {
      this.log.debug('  - notificationID specified: ' + config.notificationID);
    }

    if (this.mqttClient) {
      const options = this.mqttClient.mqttOptions;
      this.log.debug(`  - mqtt client instantiated: ${options.protocol}://${options.host}:${options.port}`);
      this.log.debug('     -> subscribing to topics:');
      for (const topic in this.mqttClient.subscriptions) {
        if (!Object.prototype.hasOwnProperty.call(this.mqttClient.subscriptions, topic)) {
          continue;
        }
        this.log.debug(`         - ${topic}`);
      }
    }
  }

  identify() {
    this.log.info('Identify requested!');
  }

  getServices() {
    if (!this.homebridgeService) {
      return [];
    }

    const informationService = new Service.AccessoryInformation();

    informationService
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, MODEL)
      .setCharacteristic(Characteristic.SerialNumber, SERIAL_NUMBER)
      .setCharacteristic(Characteristic.FirmwareRevision, FIRMWARE_REVISION);

    return [informationService, this.homebridgeService];
  }

  getControllers() {
    if (!this.adaptiveLightingController) {
      return [];
    } else {
      return [this.adaptiveLightingController];
    }
  }

  checkAdaptiveLightingSupport(api: API) {
    return api.version >= 2.7 && api.versionGreaterOrEqual('1.3.0-beta.19')
            || !!api.hap.AdaptiveLightingController; // support check on Hoobs
  }

  parseCharacteristics(config: any) {
    this.power = {};

    /** @namespace config.setPowerTopic */
    /** @namespace config.getPowerTopic */
    if (config.setPowerTopic && config.getPowerTopic) {
      this.power.isMqtt = true;
      try {
        this.power.setTopic = configParser.parseMQTTSetTopicProperty(config.setPowerTopic);
      } catch (error: any) {
        this.log.warn(`Error occurred while parsing 'setPowerTopic': ${error.message}`);
        return false;
      }
      try {
        this.power.getTopic = configParser.parseMQTTGetTopicProperty(config.getPowerTopic);
      } catch (error: any) {
        this.log.warn(`Error occurred while parsing 'getPowerTopic': ${error.message}`);
        return false;
      }
    } else if ((config.onUrl || config.power.onUrl) && (config.offUrl || config.power.offUrl)
            && (config.statusUrl || config.power.statusUrl)) {
      let url;
      try {
        url = 'onUrl';
        this.power.onUrl = this.parsePropertyWithLegacyLocation(config, config.power, url);
        url = 'offUrl';
        this.power.offUrl = this.parsePropertyWithLegacyLocation(config, config.power, url);
        url = 'statusUrl';
        this.power.statusUrl = this.parsePropertyWithLegacyLocation(config, config.power, url);
      } catch (error: any) {
        this.log.warn(`Error occurred while parsing '${url}': ${error.message}`);
        return false;
      }
    } else {
      // couldn't detect which way to go
      this.log.warn('Couldn\'t detect a proper configuration for power!'); // TODO message
      return false;
    }

    this.power.statusPattern = /1/; // default pattern
    try {
      if (config.statusPattern) {
        // statusPattern didn't exist in v0.1.1, no need for backwards compatibility lol
        this.power.statusPattern = configParser.parsePattern(config.statusPattern);
      }
    } catch (error: any) {
      this.log.warn('Error occurred while parsing \'statusPattern\': ' + error.message);
      this.log.warn('Property \'power.statusPattern\' was given in an unsupported type. Using the default one!');
    }

    if (config.brightness) {
      if (typeof config.brightness === 'object') {
        if (!config.brightness.setUrl || !config.brightness.statusUrl) {
          this.log.warn('Property \'brightness\' was defined, however some urls are missing!');
          return false;
        }

        this.brightness = {};
        let url: string = '';
        try {
          // noinspection JSUnusedAssignment
          url = 'setUrl';
          this.brightness.setUrl = configParser.parseUrlProperty(config.brightness.setUrl);
          url = 'statusUrl';
          this.brightness.statusUrl = configParser.parseUrlProperty(config.brightness.statusUrl);
        } catch (error: any) {
          this.log.warn(`Error occurred while parsing 'brightness.${url}': ${error.message}`);
          return false;
        }

        this.brightness.unit = utils.enumValueOf(BrightnessUnit, config.brightness.unit, BrightnessUnit.PERCENT);
        if (!this.brightness.unit) {
          this.log.warn(`${config.brightness.unit} is a unsupported brightness unit!`);
          return false;
        }

        this.brightness.statusPattern = /([0-9]{1,3})/; // default pattern
        try {
          if (config.brightness.statusPattern) {
            this.brightness.statusPattern = configParser.parsePattern(config.brightness.statusPattern);
          }
        } catch (error: any) {
          this.log.warn('Error occurred while parsing \'brightness.statusPattern\': ' + error.message);
          this.log.warn('Property \'brightness.statusPattern\' was given in an unsupported type. Using the default one!');
        }
        if (config.brightness.patternGroupToExtract) {
          this.brightness.patternGroupToExtract = 1;

          if (typeof config.brightness.patternGroupToExtract === 'number') {
            this.brightness.patternGroupToExtract = config.brightness.patternGroupToExtract;
          } else {
            this.log.warn('Property \'brightness.patternGroupToExtract\' must be a number! Using default value!');
          }
        }


        this.brightness.withholdPowerUpdate = config.brightness.withholdPowerUpdate || false;
        this.withholdPowerCall = false;
      } else {
        this.log.warn('Property \'brightness\' needs to be an object!');
        return false;
      }
    }

    if (config.hue) {
      if (typeof config.hue === 'object') {
        if (!config.hue.setUrl || !config.hue.statusUrl) {
          this.log.warn('Property \'hue\' was defined, however some urls are missing!');
          return false;
        }

        this.hue = {};
        let url: string = '';
        try {
          // noinspection JSUnusedAssignment
          url = 'setUrl';
          this.hue.setUrl = configParser.parseUrlProperty(config.hue.setUrl);
          url = 'statusUrl';
          this.hue.statusUrl = configParser.parseUrlProperty(config.hue.statusUrl);
        } catch (error: any) {
          this.log.warn(`Error occurred while parsing 'hue.${url}': ${error.message}`);
          return false;
        }

        this.hue.unit = utils.enumValueOf(HueUnit, config.hue.unit, HueUnit.HSV);
        if (!this.hue.unit) {
          this.log.warn(`${config.hue.unit} is a unsupported hue unit!`);
          return false;
        }

        this.hue.statusPattern = this.hue.unit === HueUnit.HSV? /([0-9]{1,3})/: /([0-9]{1,5})/; // default pattern
        try {
          if (this.hue.statusPattern) {
            this.hue.statusPattern = configParser.parsePattern(config.hue.statusPattern);
          }
        } catch (error: any) {
          this.log.warn('Error occurred while parsing \'hue.statusPattern\': ' + error.message);
          this.log.warn('Property \'hue.statusPattern\' was given in an unsupported type. Using the default one!');
        }
        if (config.hue.patternGroupToExtract) {
          this.hue.patternGroupToExtract = 1;

          if (typeof config.hue.patternGroupToExtract === 'number') {
            this.hue.patternGroupToExtract = config.hue.patternGroupToExtract;
          } else {
            this.log.warn('Property \'hue.patternGroupToExtract\' must be a number! Using default value!');
          }
        }
      } else {
        this.log.warn('Property \'hue\' needs to be an object!');
        return false;
      }
    }
    if (config.saturation) {
      if (typeof config.saturation === 'object') {
        if (!config.saturation.setUrl || !config.saturation.statusUrl) {
          this.log.warn('Property \'saturation\' was defined, however some urls are missing!');
          return false;
        }

        this.saturation = {};
        let url: string = '';
        try {
          // noinspection JSUnusedAssignment
          url = 'setUrl';
          this.saturation.setUrl = configParser.parseUrlProperty(config.saturation.setUrl);
          url = 'statusUrl';
          this.saturation.statusUrl = configParser.parseUrlProperty(config.saturation.statusUrl);
        } catch (error: any) {
          this.log.warn(`Error occurred while parsing 'saturation.${url}': ${error.message}`);
          return false;
        }

        this.saturation.unit = utils.enumValueOf(SaturationUnit, config.saturation.unit, SaturationUnit.PERCENT);
        if (!this.saturation.unit) {
          this.log.warn(`${config.saturation.unit} is a unsupported saturation unit!`);
          return false;
        }

        this.saturation.statusPattern = /([0-9]{1,3})/; // default pattern
        try {
          if (this.saturation.statusPattern) {
            this.saturation.statusPattern = configParser.parsePattern(config.saturation.statusPattern);
          }
        } catch (error: any) {
          this.log.warn('Error occurred while parsing \'saturation.statusPattern\': ' + error.message);
          this.log.warn('Property \'saturation.statusPattern\' was given in an unsupported type. Using the default one!');
        }
        if (config.saturation.patternGroupToExtract) {
          this.saturation.patternGroupToExtract = 1;

          if (typeof config.saturation.patternGroupToExtract === 'number') {
            this.saturation.patternGroupToExtract = config.saturation.patternGroupToExtract;
          } else {
            this.log.warn('Property \'saturation.patternGroupToExtract\' must be a number! Using default value!');
          }
        }
      } else {
        this.log.warn('Property \'saturation\' needs to be an object!');
        return false;
      }
    }

    if (config.colorTemperature) {
      if (typeof config.colorTemperature === 'object') {
        if (!config.colorTemperature.setUrl || !config.colorTemperature.statusUrl) {
          this.log.warn('Property \'colorTemperature\' was defined, however some urls are missing!');
          return false;
        }

        this.colorTemperature = {};
        let url: string = '';
        try {
          // noinspection JSUnusedAssignment
          url = 'setUrl';
          this.colorTemperature.setUrl = configParser.parseUrlProperty(config.colorTemperature.setUrl);
          url = 'statusUrl';
          this.colorTemperature.statusUrl = configParser.parseUrlProperty(config.colorTemperature.statusUrl);
        } catch (error: any) {
          this.log.warn(`Error occurred while parsing 'colorTemperature.${url}': ${error.message}`);
          return false;
        }

        this.colorTemperature.unit = utils.enumValueOf(TemperatureUnit, config.colorTemperature.unit, TemperatureUnit.MICRORECIPROCAL_DEGREE);
        if (!this.colorTemperature.unit) {
          this.log.warn(`${config.colorTemperature.unit} is a unsupported temperature unit!`);
          return false;
        }

        this.colorTemperature.statusPattern = this.colorTemperature.unit === TemperatureUnit.MICRORECIPROCAL_DEGREE? /([0-9]{2,3})/: /([0-9]{4,5})/;
        try {
          if (this.colorTemperature.statusPattern) {
            this.colorTemperature.statusPattern = configParser.parsePattern(config.colorTemperature.statusPattern);
          }
        } catch (error: any) {
          this.log.warn('Error occurred while parsing \'colorTemperature.statusPattern\': ' + error.message);
          this.log.warn('Property \'colorTemperature.statusPattern\' was given in an unsupported type. Using the default one!');
        }
        if (config.colorTemperature.patternGroupToExtract) {
          this.colorTemperature.patternGroupToExtract = 1;

          if (typeof config.colorTemperature.patternGroupToExtract === 'number') {
            this.colorTemperature.patternGroupToExtract = config.colorTemperature.patternGroupToExtract;
          } else {
            this.log.warn('Property \'colorTemperature.patternGroupToExtract\' must be a number! Using default value!');
          }
        }

        this.colorTemperature.minValue = 50; // HAP default values
        this.colorTemperature.maxValue = 400;

        if (config.colorTemperature.minValue) {
          if (typeof config.colorTemperature.minValue === 'number') {
            let minValue = config.colorTemperature.minValue;

            if (this.colorTemperature.unit === TemperatureUnit.KELVIN) {
              minValue = Math.floor(1000000 / minValue);
            }
            this.colorTemperature.minValue = minValue;
          } else {
            this.log.warn('\'colorTemperature.minValue\' needs to be a number. Ignoring it and using default!');
          }
        }
        if (config.colorTemperature.maxValue) {
          if (typeof config.colorTemperature.maxValue === 'number') {
            let maxValue = config.colorTemperature.maxValue;

            if (this.colorTemperature.unit === TemperatureUnit.KELVIN) {
              maxValue = Math.floor(1000000 / maxValue);
            }
            this.colorTemperature.maxValue = maxValue;
          } else {
            this.log.warn('\'colorTemperature.maxValue\' needs to be a number. Ignoring it and using default!');
          }
        }
      } else {
        this.log.warn('Property \'colorTemperature\' needs to be an object!');
        return false;
      }
    }

    return true;
  }

  parsePropertyWithLegacyLocation(location: any, legacyLocation: any, name: string) {
    const parserFunction = configParser.parseUrlProperty.bind(configParser);

    if (location[name]) {
      return parserFunction(location[name]);
    } else if (legacyLocation && typeof legacyLocation === 'object' && legacyLocation[name]) {
      return parserFunction(legacyLocation[name]);
    }
    throw new Error('parserFunction is undefined!');
  } // backwards compatibility with v0.1.1

  handleNotification(body: any) {
    if (!this.homebridgeService.testCharacteristic(body.characteristic)) {
      this.log.warn(
        'Encountered unknown characteristic when handling notification ' +
        '(or characteristic which wasn\'t added to the service): ' + body.characteristic,
      );
      return;
    }

    let value = body.value;

    if (body.characteristic === 'On' && this.pullTimer) {
      this.pullTimer.resetTimer();
    }
    if (body.characteristic === 'Brightness' && this.brightness.unit === BrightnessUnit.RGB) {
      value = Math.round((value / 254) * 100);
    }
    if (body.characteristic === 'Hue' && this.hue.unit === HueUnit.ZIGBEE) {
      value = Math.round((value / 360) * 65535);
    }
    if (body.characteristic === 'Saturation' && this.saturation.unit === SaturationUnit.RGB) {
      value = Math.round((value / 254) * 100);
    }
    if (body.characteristic === 'ColorTemperature' && this.colorTemperature.unit === TemperatureUnit.KELVIN) {
      value = Math.round(1000000 / value);
    }

    // TODO make this configurable if such requests should change the colorMode, could be unwanted
    if (body.characteristic === 'Hue' || body.characteristic === 'Saturation') {
      this.colorMode = ColorMode.COLOR;
    }
    if (body.characteristic === 'ColorTemperature') {
      this.colorMode = ColorMode.TEMPERATURE;
    }

    this.log.info('Updating \'' + body.characteristic + '\' to new value: ' + body.value);
    this.homebridgeService.getCharacteristic(body.characteristic).updateValue(value);

    if (body.characteristic === 'ColorTemperature') {
      this._updateColorByColorTemperature(value);
    }
  }

  handleMQTTMessage(value: any, callback: any, characteristic: any) {
    if (characteristic === 'On' && this.pullTimer) {
      this.pullTimer.resetTimer();
    }
    if (characteristic === 'Brightness' && this.brightness.unit === BrightnessUnit.RGB) {
      value = Math.round((value / 254) * 100);
    }
    if (characteristic === 'Hue' && this.hue.unit === HueUnit.ZIGBEE) {
      value = Math.round((value / 360) * 65535);
    }
    if (characteristic === 'Saturation' && this.saturation.unit === SaturationUnit.RGB) {
      value = Math.round((value / 254) * 100);
    }
    if (characteristic === 'ColorTemperature' && this.colorTemperature.unit === TemperatureUnit.KELVIN) {
      value = Math.round(1000000 / value);
    }

    // TODO make this configurable if such requests should change the colorMode, could be unwanted
    if (characteristic === 'Hue' || characteristic === 'Saturation') {
      this.colorMode = ColorMode.COLOR;
    }
    if (characteristic === 'ColorTemperature') {
      this.colorMode = ColorMode.TEMPERATURE;
    }

    callback(value);
  }

  getPowerState = async(): Promise<boolean> => {
    if (this.pullTimer) {
      this.pullTimer.resetTimer();
    }

    // if mqtt is enabled just return the current value
    if (this.power.isMqtt || !this.statusCache.shouldQuery()) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.On).value;
      this.log.debug(`getPowerState() returning cached value '${value ? 'ON' : 'OFF'}'${this.statusCache.isInfinite() ? ' (infinite cache)' : ''}`);
      return !!value;
    }

    try {
      const response = await http.httpRequest(this.power.statusUrl);
      let body = response.data;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      this.log.debug(`getPowerState() request returned successfully (${response.status}). Body: '${body}'`);

      const switchedOn = this.power.statusPattern.test(body);

      this.log.info('Power is currently %s', switchedOn ? 'ON' : 'OFF');

      this.statusCache.queried();
      return switchedOn;
    } catch (error: any) {
      this.log.error(`getPowerState() failed: ${error.response.status}: ${error.response.data} ${error.message}`);
      throw error;
    }
  }

  setPowerState = async (on: boolean): Promise<void> => {
    if (on && this.withholdPowerCall && this.homebridgeService.getCharacteristic(Characteristic.On).value) {
      this.withholdPowerCall = false;
      return;
    }

    if (this.pullTimer) {
      this.pullTimer.resetTimer();
    }

    if (!this.power.isMqtt) {
      try {
        const urlObject = on ? this.power.onUrl : this.power.offUrl;
        const response = await http.httpRequest(urlObject);
        if (response.status !== 200) {
          this.log.error(`setPowerState() http request returned http error code ${response.status}: ${response.data}`);
          throw new Error('Got html error code ' + response.status);
        }
        this.log.debug(`Successfully set power to ${on ? 'ON' : 'OFF'}.`);
      } catch (error: any) {
        this.log.error(`setPowerState() http request failed: ${error.message}`);
        throw error;
      }
    } else {
      this.mqttClient.publish(this.power.setTopic, on, (error: any) => {
        if (error) {
          this.log.error(`setPowerState() error occurred publishing to ${this.power.setTopic}: ${error.message}`);
        } else {
          this.log.debug(`Successfully set power to ${on ? 'ON' : 'OFF'}`);
        }
      });
    }
  }

  getBrightness = async(): Promise<number> => {
    if (!this.brightnessCache.shouldQuery()) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.Brightness).value;
      this.log.debug(`getBrightness() returning cached value '${value}'${this.brightnessCache.isInfinite()? ' (infinite cache)': ''}`);
      return value;
    }

    try {
      const response = await http.httpRequest(this.brightness.statusUrl);
      let body = response.data;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      this.log.debug(`getBrightness() request returned successfully (${response.status}). Body: '${body}'`);

      let brightness;
      try {
        brightness = parseInt(utils.extractValueFromPattern(this.brightness.statusPattern, body, this.brightness.patternGroupToExtract));
      } catch (error: any) {
        this.log.error('getBrightness() error occurred while extracting brightness from body: ' + error.message);
        throw new Error('pattern error');
      }

      if (this.brightness.unit === BrightnessUnit.RGB) {
        brightness = Math.round((brightness / 254) * 100);
      }

      if (brightness >= 0 && brightness <= 100) {
        this.log.info('Brightness is currently at %s%%', brightness);

        this.brightnessCache.queried();
        return brightness;
      } else {
        this.log.warn('getBrightness() brightness is not in range of 0-100 % (actual: %s)', brightness);
        throw new Error('invalid range');
      }
    } catch (error: any) {
      if (error.response) {
        this.log.error(`getBrightness() http request returned http error code ${error.response.status}: ${error.response.data}`);
        throw new Error('Got html error code ' + error.response.status);
      } else {
        this.log.error('getBrightness() failed: %s', error.message);
        throw error;
      }
    }
  }

  setBrightness = async (brightness: number): Promise<void> => {
    const brightnessPercentage = brightness;
    if (this.brightness.unit === BrightnessUnit.RGB) {
      brightness = Math.round((brightness * 254) / 100);
    }

    if (this.brightness.withholdPowerUpdate) {
      this.withholdPowerCall = true;
    }

    try {
      const response = await http.httpRequest(
        this.brightness.setUrl,
        { searchValue: '%s', replacer: `${brightness}` },
        ...this._collectCurrentValuesForReplacer(),
      );

      this.log.debug(`Successfully set brightness to ${brightnessPercentage}%. Body: '${response.data}'`);
    } catch (error: any) {
      this.log.error(`setBrightness() failed: ${error.response.status}: ${error.response.data} ${error.message}`);
      throw error;
    }
  }

  getHue = async(): Promise<number> => {
    if (this.colorMode === ColorMode.TEMPERATURE) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.Hue).value;
      this.log.debug(`getHue() returning cached value '${value}'${this.hueCache.isInfinite()? ' (infinite cache)': ''}`);
      return value;
    }

    if (!this.hueCache.shouldQuery()) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.Hue).value;
      this.log.debug(`getHue() returning cached value '${value}'${this.hueCache.isInfinite()? ' (infinite cache)': ''}`);
      return value;
    }

    try {
      const response = await http.httpRequest(this.hue.statusUrl);
      let body = response.data;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      this.log.debug(`getHue() request returned successfully (${response.status}). Body '${body}'`);

      let hue;
      try {
        hue = parseFloat(utils.extractValueFromPattern(this.hue.statusPattern, body, this.hue.patternGroupToExtract));
      } catch (error: any) {
        this.log.error('getHue() error occurred while extracting hue from body: ' + error.message);
        throw new Error('pattern error');
      }

      if (this.hue.unit === HueUnit.ZIGBEE) {
        hue = Math.round((hue * 360) / 65535);
      }

      if (hue >= 0 && hue <= 360) {
        this.log.info('Hue is currently at %s', hue);

        this.hueCache.queried();
        return hue;
      } else {
        this.log.warn('getHue() hue is not in range of 0-360 (actual: %s)', hue);
        throw new Error('invalid range');
      }
    } catch (error: any) {
      if (error.response) {
        this.log.error(`getHue() http request returned http error code ${error.response.status}: ${error.response.data}`);
        throw new Error('Got html error code ' + error.response.status);
      } else {
        this.log.error('getHue() failed: %s', error.message);
        throw error;
      }
    }
  }

  setHue = async (hue: number): Promise<void> => {
    const hueHSV = hue;
    if (this.hue.unit === HueUnit.ZIGBEE) {
      hue = Math.round((hue / 360) * 65535);
    }

    try {
      const response = await http.httpRequest(this.hue.setUrl, { searchValue: '%s', replacer: `${hue}` }, ...this._collectCurrentValuesForReplacer());
      this.log.debug(`Successfully set hue to ${hueHSV}. Body: '${response.data}'`);

      this.colorMode = ColorMode.COLOR;
    } catch (error: any) {
      this.log.error(`setHue() failed: ${error.response.status}: ${error.response.data} ${error.message}`);
      throw error;
    }
  }

  getSaturation = async (): Promise<number> => {
    if (this.colorMode === ColorMode.TEMPERATURE) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.Saturation).value;
      this.log.debug(`getSaturation() returning cached value '${value}'${this.saturationCache.isInfinite()? ' (infinite cache)': ''}`);
      return value;
    }

    if (!this.saturationCache.shouldQuery()) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.Saturation).value;
      this.log.debug(`getSaturation() returning cached value '${value}'${this.saturationCache.isInfinite()? ' (infinite cache)': ''}`);
      return value;
    }

    try {
      const response = await http.httpRequest(this.saturation.statusUrl);
      let body = response.data;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      this.log.debug(`getSaturation() request returned successfully (${response.status}). Body '${body}'`);

      let saturation;
      try {
        saturation = parseFloat(utils.extractValueFromPattern(this.saturation.statusPattern, body, this.saturation.patternGroupToExtract));
      } catch (error: any) {
        this.log.error('getSaturation() error occurred while extracting saturation from body: ' + error.message);
        throw new Error('pattern error');
      }

      if (this.saturation.unit === SaturationUnit.RGB) {
        saturation = Math.round((saturation / 254) * 100);
      }

      if (saturation >= 0 && saturation <= 100) {
        this.log.info('Saturation is currently at %s%', saturation);

        this.saturationCache.queried();
        return saturation;
      } else {
        this.log.warn('getSaturation() saturation is not in range of 0-100 (actual: %s)', saturation);
        throw new Error('invalid range');
      }
    } catch (error: any) {
      if (error.response) {
        this.log.error(`getSaturation() http request returned http error code ${error.response.status}: ${error.response.data}`);
        throw new Error('Got html error code ' + error.response.status);
      } else {
        this.log.error('getSaturation() failed: %s', error.message);
        throw error;
      }
    }
  }

  setSaturation = async (saturation: number): Promise<void> => {
    const saturationPercentage = saturation;
    if (this.saturation.unit === SaturationUnit.RGB) {
      saturation = Math.round((saturation * 254) / 100);
    }

    try {
      const response = await http.httpRequest(
        this.saturation.setUrl,
        { searchValue: '%s', replacer: `${saturation}` },
        ...this._collectCurrentValuesForReplacer(),
      );
      this.log.debug(`Successfully set saturation to ${saturationPercentage}%. Body: '${response.data}'`);

      this.colorMode = ColorMode.COLOR;
    } catch (error: any) {
      this.log.error(`setSaturation() failed: ${error.response.status}: ${error.response.data} ${error.message}`);
      throw error;
    }
  }

  getColorTemperature = async (): Promise<number> => {
    if (!this.colorTemperatureCache.shouldQuery()) {
      const value = this.homebridgeService.getCharacteristic(Characteristic.ColorTemperature).value;
      this.log.debug(`getColorTemperature() returning cached value '${value}'${this.colorTemperatureCache.isInfinite()? ' (infinite cache)': ''}`);

      return value;
    }

    if (this.colorMode !== ColorMode.TEMPERATURE) {
      return this.colorTemperature.minValue;
    }

    try {
      const response = await http.httpRequest(this.colorTemperature.statusUrl);
      let body = response.data;
      if (typeof body !== 'string') {
        body = JSON.stringify(body);
      }
      this.log.debug(`getColorTemperature() request returned successfully (${response.status}). Body '${body}'`);

      let colorTemperature;
      try {
        colorTemperature = parseInt(utils.extractValueFromPattern(this.colorTemperature.statusPattern, body, this.colorTemperature.patternGroupToExtract));
      } catch (error: any) {
        this.log.error('getColorTemperature() error occurred while extracting colorTemperature from body: ' + error.message);
        throw new Error('pattern error');
      }

      if (this.colorTemperature.unit === TemperatureUnit.KELVIN) {
        colorTemperature = Math.round(1000000 / colorTemperature);
      } // converting Kelvin to mired

      if (colorTemperature >= this.colorTemperature.minValue && colorTemperature <= this.colorTemperature.maxValue) {
        this.log.info(`colorTemperature is currently at ${colorTemperature} Mired`);

        this.colorTemperatureCache.queried();
        return colorTemperature;
      } else {
        this.log.warn('getColorTemperature() colorTemperature is not in range of 0-100 (actual: %s)', colorTemperature);
        throw new Error('invalid range');
      }
    } catch (error: any) {
      if (error.response) {
        this.log.error(`getColorTemperature() http request returned http error code ${error.response.status}: ${error.response.data}`);
        throw new Error('Got html error code ' + error.response.status);
      } else {
        this.log.error('getColorTemperature() failed: %s', error.message);
        if (error.response) {
          this.log.error(`getColorTemperature() http request returned http error code ${error.response.status}: ${error.response.data}`);
          throw new Error('Got html error code ' + error.response.status);
        } else {
          this.log.error('getColorTemperature() failed: %s', error.message);
          throw error;
        }
      }
    }
  }

  setColorTemperature = async (colorTemperature: number): Promise<void> => {
    const colorTemperatureMired = colorTemperature;
    if (this.colorTemperature.unit === TemperatureUnit.KELVIN) {
      colorTemperature = Math.round(1000000 / colorTemperature);
    } // converting mired to Kelvin

    try {
      const response = await http.httpRequest(
        this.colorTemperature.setUrl,
        { searchValue: '%s', replacer: `${colorTemperature}` },
        ...this._collectCurrentValuesForReplacer(),
      );
      this.log.debug(`Successfully set colorTemperature to ${colorTemperatureMired} Mired. Body: '${response.data}'`);

      this.colorMode = ColorMode.TEMPERATURE;
    } catch (error: any) {
      this.log.error(`setColorTemperature() failed: ${error.response.status}: ${error.response.data} ${error.message}`);
      throw error;
    }
  }

  _collectCurrentValuesForReplacer() {
    const args: { searchValue: string; replacer: string }[] = [];

    if (this.brightness) {
      let brightness = this.homebridgeService.getCharacteristic(Characteristic.Brightness).value;
      if (this.brightness.unit === BrightnessUnit.RGB) {
        brightness = Math.round((brightness * 254) / 100);
      }

      args.push({searchValue: '%brightness', replacer: `${brightness}`});
    }
    if (this.hue) {
      let hue = this.homebridgeService.getCharacteristic(Characteristic.Hue).value;
      if (this.hue.unit === HueUnit.ZIGBEE) {
        hue = Math.round((hue / 360) * 65535);
      }

      args.push({searchValue: '%hue', replacer: `${hue}`});
    }
    if (this.saturation) {
      let saturation = this.homebridgeService.getCharacteristic(Characteristic.Saturation).value;
      if (this.saturation.unit === BrightnessUnit.RGB) {
        saturation = Math.round((saturation * 254) / 100);
      }

      args.push({searchValue: '%saturation', replacer: `${saturation}`});
    }
    /** @namespace Characteristic.ColorTemperature */
    if (this.colorTemperature) {
      let colorTemperature = this.homebridgeService.getCharacteristic(Characteristic.ColorTemperature).value;
      if (this.colorTemperature.unit === TemperatureUnit.KELVIN) {
        colorTemperature = Math.round(1000000 / colorTemperature);
      }

      args.push({searchValue: '%colorTemperature', replacer: `${colorTemperature}`});
    }

    return args;
  }

  _updateColorByColorTemperature(colorTemperature: number) {
    if (!this.hue && !this.saturation) {
      return;
    }

    let hue;
    let saturation;

    if (this.adaptiveLightingSupport) {
      const color = this.api.hap.ColorUtils.colorTemperatureToHueAndSaturation(colorTemperature);
      hue = color.hue;
      saturation = color.saturation;
    } else { // this algorithm is actually completely broken
      const rgbObject = this._temperatureToRGB(colorTemperature);
      const hsvObject = this._RGBtoHSV(rgbObject.red, rgbObject.green, rgbObject.blue);
      hue = hsvObject.hue;
      saturation = hsvObject.saturation;
    }

    if (this.hue) {
      this.homebridgeService.getCharacteristic(Characteristic.Hue).updateValue(hue);
    }
    if (this.saturation) {
      this.homebridgeService.getCharacteristic(Characteristic.Saturation).updateValue(saturation);
    }
  }

  _temperatureToRGB(temperature: number) {
    // temperature gets passed in in Mired
    temperature = 1000000 / temperature; // algorithm needs temperature in Kelvin

    temperature /= 100;

    let red = 0;
    let green = 0;
    let blue = 0;

    if (temperature <= 66) {
      red = 255;
    } else {
      red = temperature - 60;
      red = 329.698727446 * (red ^ -0.1332047592);
      red = Math.min(Math.max(red, 0), 255);
    }

    if (temperature <= 66) {
      green = temperature;
      green = 99.4708025861 * Math.log(green) - 161.1195681661;
      green = Math.min(Math.max(green, 0), 255);
    } else {
      green = temperature - 60;
      green = 288.1221695283 * (green ^ -0.0755148492);
      green = Math.min(Math.max(green, 0), 255);
    }

    if (temperature >= 66) {
      blue = 255;
    } else {
      if (temperature <= 19) {
        blue = 0;
      } else {
        blue = temperature - 10;
        blue = 138.5177312231 * Math.log(blue) - 305.0447927307;
        blue = Math.min(Math.max(blue, 0), 255);
      }
    }

    return {red: red, green: green, blue: blue};
  }

  _RGBtoHSV(r: number, g: number, b: number) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, Math.max(g, b));
    const min = Math.min(r, Math.min(g, b));
    const delta = max - min;

    let h: number = 0;
    let s = max === 0? 0: delta / max;
    let v = max;

    if (max === min) {
      h = 0;
    } else if (max === r) {
      // noinspection PointlessArithmeticExpressionJS
      h = 60 * (0 + (g-b) / delta);
    } else if (max === g) {
      h = 60 * (2 + (b-r) / delta);
    } else if (max === b) {
      h = 60 * (4 + (r-g) / delta);
    }

    return {hue: Math.round(h), saturation: Math.round(s * 100), value: Math.round(v * 100)};
  }

};

export default plugin;
