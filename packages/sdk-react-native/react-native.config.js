// Self-describing config (see https://github.com/react-native-community/cli/blob/main/docs/dependencies.md):
// libraries export a singular `dependency` key, not `dependencies` keyed by
// their own name - that shape is for an *app's* react-native.config.js
// overriding a dependency, and autolinkers (Expo's and the classic RN CLI)
// only read `dependency` when loading a package's own config.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: "import com.cohorly.reactnative.CohorlyReactNativePackage;",
        packageInstance: "new CohorlyReactNativePackage()",
      },
      ios: {},
    },
  },
};
