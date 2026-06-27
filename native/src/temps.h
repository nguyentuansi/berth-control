// Apple Silicon SoC temperature reader — C header.
//
// Ported into berth-control from macos-temperature-sensor v1.0.4
// (https://github.com/sebhildebrandt/macos-temperature-sensor) under the
// MIT license. Original work Copyright (c) 2025 Sebastian Hildebrandt.
// See LICENSE-THIRD-PARTY.md for the full upstream license text. We carry
// the source in-tree so berth-control owns its temperature path and has
// no runtime dependency on the upstream npm package.

#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  char name[128];   // service "Product" string from IOHIDServiceClient
  double temp_c;    // Celsius
} bt_sensor_t;

typedef struct {
  double p_core_avg_c;
  double e_core_avg_c;
  size_t sensor_count;
  bt_sensor_t* sensors;
} bt_snapshot_t;

int bt_read_snapshot(bt_snapshot_t* out);

void bt_free_snapshot(bt_snapshot_t* s);

#ifdef __cplusplus
}
#endif
