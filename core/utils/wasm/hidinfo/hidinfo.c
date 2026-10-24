// SPDX-License-Identifier: MIT OR Apache-2.0
// hidinfo: lists the HID devices of /dev/hidraw*, with what the hidraw ioctls say of each (see linux/hidraw.h).
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

// linux/hidraw.h, which the toolchain's headers do not have
struct hidraw_report_descriptor { uint32_t size; uint8_t value[4096]; };
struct hidraw_devinfo { uint32_t bustype; int16_t vendor; int16_t product; };
#define HIDIOCGRDESCSIZE _IOR('H', 0x01, int)
#define HIDIOCGRDESC _IOR('H', 0x02, struct hidraw_report_descriptor)
#define HIDIOCGRAWINFO _IOR('H', 0x03, struct hidraw_devinfo)
#define HIDIOCGRAWNAME(len) _IOC(_IOC_READ, 'H', 0x04, len)
#define HIDIOCGRAWPHYS(len) _IOC(_IOC_READ, 'H', 0x05, len)
#define HIDIOCGFEATURE(len) _IOC(_IOC_READ | _IOC_WRITE, 'H', 0x07, len)

static int dump_descriptor, feature_id = -1;

static int show(const char *path) {
  int fd = open(path, O_RDWR);
  if (fd < 0) { fprintf(stderr, "hidinfo: %s: %s\n", path, strerror(errno)); return 1; }
  int size = 0;
  struct hidraw_devinfo info;
  char name[256] = "", phys[256] = "";
  if (ioctl(fd, HIDIOCGRDESCSIZE, &size) < 0 || ioctl(fd, HIDIOCGRAWINFO, &info) < 0) {
    fprintf(stderr, "hidinfo: %s: %s\n", path, strerror(errno));
    close(fd);
    return 1;
  }
  ioctl(fd, HIDIOCGRAWNAME(256), name);
  ioctl(fd, HIDIOCGRAWPHYS(256), phys);
  printf("%s: %s\n  bus %u, vendor %04hx, product %04hx\n  phys %s\n  report descriptor %d bytes\n", path, name, info.bustype,
         (unsigned short)info.vendor, (unsigned short)info.product, phys, size);
  if (dump_descriptor) {
    static struct hidraw_report_descriptor desc;
    desc.size = size;
    if (ioctl(fd, HIDIOCGRDESC, &desc) < 0) { perror("hidinfo: HIDIOCGRDESC"); close(fd); return 1; }
    for (uint32_t i = 0; i < desc.size; i++) printf("%02x%c", desc.value[i], i % 16 == 15 || i + 1 == desc.size ? '\n' : ' ');
  }
  if (feature_id >= 0) {
    uint8_t buf[256] = { (uint8_t)feature_id };
    int got = ioctl(fd, HIDIOCGFEATURE(sizeof buf), buf);
    if (got < 0) { perror("hidinfo: HIDIOCGFEATURE"); close(fd); return 1; }
    printf("  feature report %d:", feature_id);
    for (int i = 0; i < got; i++) printf(" %02x", buf[i]);
    printf("\n");
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  int status = 0, option;
  while ((option = getopt(argc, argv, "df:")) != -1) {
    if (option == 'd') dump_descriptor = 1;
    else if (option == 'f') feature_id = atoi(optarg);
    else { fprintf(stderr, "usage: hidinfo [-d] [-f REPORT_ID] [DEVICE...]\n"); return 2; }
  }
  if (optind < argc) {
    for (int i = optind; i < argc; i++) status |= show(argv[i]);
    return status;
  }
  DIR *dir = opendir("/dev");
  if (!dir) { perror("hidinfo: /dev"); return 1; }
  struct dirent *entry;
  int found = 0;
  while ((entry = readdir(dir))) {
    if (strncmp(entry->d_name, "hidraw", 6) != 0) continue;
    char path[300];
    snprintf(path, sizeof path, "/dev/%s", entry->d_name);
    found = 1;
    status |= show(path);
  }
  closedir(dir);
  if (!found) fprintf(stderr, "hidinfo: no HID devices (see 'hid request')\n");
  return found ? status : 1;
}
