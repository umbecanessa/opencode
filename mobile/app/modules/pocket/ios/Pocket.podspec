Pod::Spec.new do |s|
  s.name         = 'Pocket'
  s.version      = '1.0.0'
  s.summary      = 'Toggle Pocket Recording App Intent and its JS bridge.'
  s.description  = 'Local Expo module exposing a native Toggle Pocket Recording App Intent; the action is stashed in UserDefaults and consumed by the JS Pocket screen (app/pocket.tsx).'
  s.homepage     = 'https://github.com/umbecanessa/opencode'
  s.license      = { :type => 'MIT' }
  s.author       = 'Umberto Canessa'
  s.source       = { :git => 'https://github.com/umbecanessa/opencode.git', :tag => s.version.to_s }

  # App Intents need iOS 16; the app's own deployment target is already above it.
  s.platforms    = { :ios => '16.0' }
  # source_files are relative to this file, which sits inside ios/.
  s.source_files = '**/*.swift'
  s.swift_version = '5.9'

  s.dependency 'ExpoModulesCore'
end
