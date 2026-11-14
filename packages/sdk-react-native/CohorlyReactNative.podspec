require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = "CohorlyReactNative"
  s.version      = package['version']
  s.summary      = "Native device info and crash reporting for @cohorly/react-native"
  s.license      = package['license']
  s.author       = { 'Cohorly' => 'giovanne.tarcitano@velloalabs.com' }
  s.homepage     = package['repository']['url']
  s.platform     = :ios, "12.0"
  s.swift_version = '5.0'
  s.source       = { :git => package['repository']['url'], :tag => s.version }
  s.source_files = "ios/**/*.{swift,h,m}"
  s.requires_arc = true
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  s.dependency "React-Core"
  # Native crash reporting (ADR-0020): KSCrash's recording module only.
  s.dependency "KSCrash/Recording", "~> 2.6"
  s.weak_frameworks = "MetricKit"
end
