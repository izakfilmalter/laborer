{
  "targets": [
    {
      "target_name": "ghostty_addon",
      "sources": ["src/addon.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../vendor/ghostty/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        [
          "OS=='mac'",
          {
            "libraries": [
              "<(module_root_dir)/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a",
              "-framework AppKit",
              "-framework Carbon",
              "-framework CoreFoundation",
              "-framework CoreGraphics",
              "-framework CoreText",
              "-framework CoreVideo",
              "-framework Foundation",
              "-framework GameController",
              "-framework IOSurface",
              "-framework Metal",
              "-framework MetalKit",
              "-framework QuartzCore",
              "-framework UniformTypeIdentifiers"
            ],
            "xcode_settings": {
              "OTHER_LDFLAGS": ["-ObjC"],
              "MACOSX_DEPLOYMENT_TARGET": "14.0"
            }
          }
        ]
      ]
    }
  ]
}
