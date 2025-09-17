module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      'react-native-worklets/plugin',
      // (opcional si viste el error de VirtualView `match`):
      ['babel-plugin-syntax-hermes-parser', { flow: true }],
    ],
  };
};
