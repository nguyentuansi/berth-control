{
  "targets": [
    {
      "target_name": "berth_temp",
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/addon.c",
            "src/temps.c"
          ],
          "cflags": ["-std=c11", "-Wall", "-Wextra", "-Wno-unused-parameter"],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_CFLAGS": ["-std=c11"]
          },
          "libraries": [
            "-framework CoreFoundation",
            "-framework IOKit",
            "-ldl"
          ]
        }],
        ["OS!='mac'", {
          "type": "none"
        }]
      ]
    }
  ]
}
