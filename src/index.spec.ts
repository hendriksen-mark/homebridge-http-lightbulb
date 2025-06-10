import plugin from './index';

describe('homebridge-http-lightbulb plugin', () => {
  it('should export a function', () => {
    expect(typeof plugin).toBe('function');
  });

  it('should register accessory when called with mock API', () => {
    const registerAccessory = jest.fn();
    const api = {
      hap: {
        Service: {},
        Characteristic: {},
        AdaptiveLightingController: jest.fn(),
        ColorUtils: { colorTemperatureToHueAndSaturation: jest.fn(() => ({ hue: 0, saturation: 0 })) },
      },
      version: 3,
      versionGreaterOrEqual: () => true,
      registerAccessory,
    };
    plugin(api as any);
    expect(registerAccessory).toHaveBeenCalled();
  });
});
