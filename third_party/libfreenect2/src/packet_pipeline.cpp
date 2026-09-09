/*
 * This file is part of the OpenKinect Project. http://www.openkinect.org
 *
 * Copyright (c) 2014 individual OpenKinect contributors. See the CONTRIB file
 * for details.
 *
 * This code is licensed to you under the terms of the Apache License, version
 * 2.0, or, at your option, the terms of the GNU General Public License,
 * version 2.0. See the APACHE20 and GPL2 files for the text of the licenses,
 * or the following URLs:
 * http://www.apache.org/licenses/LICENSE-2.0
 * http://www.gnu.org/licenses/gpl-2.0.txt
 *
 * If you redistribute this file in source form, modified or unmodified, you
 * may:
 *   1) Leave this header intact and distribute it under the same terms,
 *      accompanying it with the APACHE20 and GPL20 files, or
 *   2) Delete the Apache 2.0 clause and accompany it with the GPL2 file, or
 *   3) Delete the GPL v2 clause and accompany it with the APACHE20 file
 * In all cases you must keep the copyright notice intact and include a copy
 * of the CONTRIB file.
 *
 * Binary distributions must follow the binary distribution requirements of
 * either License.
 */

/*
 * NOTICE OF MODIFICATION. This file is not upstream libfreenect2. It was
 * changed by Tim Kraus on 2026-09-09, on top of upstream v0.2.1, for the
 * Braindance project: the colour decoder became a caller's choice.
 * getDefaultRgbPacketProcessor is replaced by defaultColorDecoder and
 * createRgbPacketProcessor, every pipeline gained a constructor taking a
 * decoder, the default prefers software decode over a hardware decoder that
 * can lose its device context, and the runtime substitution of TurboJPEG for a
 * failed VAAPI or Tegra decoder is gone. Every altered region below is marked
 * "LOCAL EDIT"; third_party/UPSTREAM.md carries the reasoning.
 */

/** @file packet_pipeline.cpp Packet pipeline implementation. */

#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/async_packet_processor.h>
#include <libfreenect2/data_callback.h>
#include <libfreenect2/rgb_packet_stream_parser.h>
#include <libfreenect2/depth_packet_stream_parser.h>
#include <libfreenect2/protocol/response.h>

namespace libfreenect2
{

// LOCAL EDIT: the build's own pick, named so a caller can read it and so the grabber does not
// keep a second copy of this order. VideoToolbox first, because it is the decoder Apple ships a
// path for and nothing has been reported against it. Then TurboJPEG, which decodes on the CPU
// and so cannot lose a device context mid-stream. The hardware decoders that can are last, and
// on any build carrying TurboJPEG they are reached only by asking for them.
ColorDecoder defaultColorDecoder()
{
#if defined(LIBFREENECT2_WITH_VT_SUPPORT)
  return ColorDecoder::VideoToolbox;
#elif defined(LIBFREENECT2_WITH_TURBOJPEG_SUPPORT)
  return ColorDecoder::TurboJPEG;
#elif defined(LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT)
  return ColorDecoder::TegraJPEG;
#elif defined(LIBFREENECT2_WITH_VAAPI_SUPPORT)
  return ColorDecoder::VAAPI;
#else
  #error No jpeg decoder is enabled
#endif
}

// LOCAL EDIT: one case per enumerator, each gated the way its enumerator is, so a decoder this
// build cannot construct cannot be named. Nothing tests good() and nothing substitutes: a
// hardware decoder that starts and later loses its context is a fault to report, and both the
// failed start and the failed frame already log for themselves.
static RgbPacketProcessor *createRgbPacketProcessor(ColorDecoder decoder)
{
  switch (decoder)
  {
#ifdef LIBFREENECT2_WITH_VT_SUPPORT
  case ColorDecoder::VideoToolbox: return new VTRgbPacketProcessor();
#endif
#ifdef LIBFREENECT2_WITH_TURBOJPEG_SUPPORT
  case ColorDecoder::TurboJPEG:    return new TurboJpegRgbPacketProcessor();
#endif
#ifdef LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT
  case ColorDecoder::TegraJPEG:    return new TegraJpegRgbPacketProcessor();
#endif
#ifdef LIBFREENECT2_WITH_VAAPI_SUPPORT
  case ColorDecoder::VAAPI:        return new VaapiRgbPacketProcessor();
#endif
  }
  // Unreachable: defaultColorDecoder's #error means every build has at least one enumerator, and
  // every enumerator has a case above. Present for -Wreturn-type.
  return NULL;
}

class PacketPipelineComponents
{
public:
  RgbPacketStreamParser *rgb_parser_;
  DepthPacketStreamParser *depth_parser_;

  RgbPacketProcessor *rgb_processor_;
  BaseRgbPacketProcessor *async_rgb_processor_;
  DepthPacketProcessor *depth_processor_;
  BaseDepthPacketProcessor *async_depth_processor_;

  ~PacketPipelineComponents();
  void initialize(RgbPacketProcessor *rgb, DepthPacketProcessor *depth);
};

void PacketPipelineComponents::initialize(RgbPacketProcessor *rgb, DepthPacketProcessor *depth)
{
  rgb_parser_ = new RgbPacketStreamParser();
  depth_parser_ = new DepthPacketStreamParser();

  rgb_processor_ = rgb;
  depth_processor_ = depth;

  async_rgb_processor_ = new AsyncPacketProcessor<RgbPacket>(rgb_processor_);
  async_depth_processor_ = new AsyncPacketProcessor<DepthPacket>(depth_processor_);

  rgb_parser_->setPacketProcessor(async_rgb_processor_);
  depth_parser_->setPacketProcessor(async_depth_processor_);
}

PacketPipelineComponents::~PacketPipelineComponents()
{
  delete async_rgb_processor_;
  delete async_depth_processor_;
  delete rgb_processor_;
  delete depth_processor_;
  delete rgb_parser_;
  delete depth_parser_;
}

PacketPipeline::PacketPipeline(): comp_(new PacketPipelineComponents()) {}

PacketPipeline::~PacketPipeline()
{
  delete comp_;
}

PacketPipeline::PacketParser *PacketPipeline::getRgbPacketParser() const
{
  return comp_->rgb_parser_;
}

PacketPipeline::PacketParser *PacketPipeline::getIrPacketParser() const
{
  return comp_->depth_parser_;
}

RgbPacketProcessor *PacketPipeline::getRgbPacketProcessor() const
{
  return comp_->rgb_processor_;
}

DepthPacketProcessor *PacketPipeline::getDepthPacketProcessor() const
{
  return comp_->depth_processor_;
}

CpuPacketPipeline::CpuPacketPipeline()
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new CpuDepthPacketProcessor());
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
CpuPacketPipeline::CpuPacketPipeline(ColorDecoder decoder)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new CpuDepthPacketProcessor());
}

CpuPacketPipeline::~CpuPacketPipeline() { }

#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
OpenGLPacketPipeline::OpenGLPacketPipeline(void *parent_opengl_context, bool debug) : parent_opengl_context_(parent_opengl_context), debug_(debug)
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new OpenGLDepthPacketProcessor(parent_opengl_context_, debug_));
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
OpenGLPacketPipeline::OpenGLPacketPipeline(void *parent_opengl_context, bool debug, ColorDecoder decoder) : parent_opengl_context_(parent_opengl_context), debug_(debug)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new OpenGLDepthPacketProcessor(parent_opengl_context_, debug_));
}

OpenGLPacketPipeline::~OpenGLPacketPipeline() { }
#endif // LIBFREENECT2_WITH_OPENGL_SUPPORT


#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
OpenCLPacketPipeline::OpenCLPacketPipeline(const int deviceId) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new OpenCLDepthPacketProcessor(deviceId));
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
OpenCLPacketPipeline::OpenCLPacketPipeline(const int deviceId, ColorDecoder decoder) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new OpenCLDepthPacketProcessor(deviceId));
}

OpenCLPacketPipeline::~OpenCLPacketPipeline() { }


OpenCLKdePacketPipeline::OpenCLKdePacketPipeline(const int deviceId) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new OpenCLKdeDepthPacketProcessor(deviceId));
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
OpenCLKdePacketPipeline::OpenCLKdePacketPipeline(const int deviceId, ColorDecoder decoder) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new OpenCLKdeDepthPacketProcessor(deviceId));
}

OpenCLKdePacketPipeline::~OpenCLKdePacketPipeline() { }
#endif // LIBFREENECT2_WITH_OPENCL_SUPPORT

#ifdef LIBFREENECT2_WITH_CUDA_SUPPORT
CudaPacketPipeline::CudaPacketPipeline(const int deviceId) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new CudaDepthPacketProcessor(deviceId));
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
CudaPacketPipeline::CudaPacketPipeline(const int deviceId, ColorDecoder decoder) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new CudaDepthPacketProcessor(deviceId));
}

CudaKdePacketPipeline::~CudaKdePacketPipeline() { }

CudaKdePacketPipeline::CudaKdePacketPipeline(const int deviceId) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(defaultColorDecoder()), new CudaKdeDepthPacketProcessor(deviceId));
}

// LOCAL EDIT: the same pipeline, with the decoder named by the caller.
CudaKdePacketPipeline::CudaKdePacketPipeline(const int deviceId, ColorDecoder decoder) : deviceId(deviceId)
{
  comp_->initialize(createRgbPacketProcessor(decoder), new CudaKdeDepthPacketProcessor(deviceId));
}

CudaPacketPipeline::~CudaPacketPipeline() { }
#endif // LIBFREENECT2_WITH_CUDA_SUPPORT

DumpPacketPipeline::DumpPacketPipeline()
{
  RgbPacketProcessor *rgb = new DumpRgbPacketProcessor();
  DepthPacketProcessor *depth = new DumpDepthPacketProcessor();
  comp_->initialize(rgb, depth);
}

DumpPacketPipeline::~DumpPacketPipeline() {}

const unsigned char* DumpPacketPipeline::getDepthP0Tables(size_t* length) {
  *length = sizeof(libfreenect2::protocol::P0TablesResponse);
  return static_cast<DumpDepthPacketProcessor*>(getDepthPacketProcessor())->getP0Tables();
}

const float* DumpPacketPipeline::getDepthXTable(size_t* length) {
  *length = DepthPacketProcessor::TABLE_SIZE;
  return static_cast<DumpDepthPacketProcessor*>(getDepthPacketProcessor())->getXTable();
}

const float* DumpPacketPipeline::getDepthZTable(size_t* length) {
  *length = DepthPacketProcessor::TABLE_SIZE;
  return static_cast<DumpDepthPacketProcessor*>(getDepthPacketProcessor())->getZTable();
}

const short* DumpPacketPipeline::getDepthLookupTable(size_t* length) {
  *length = DepthPacketProcessor::LUT_SIZE;
  return static_cast<DumpDepthPacketProcessor*>(getDepthPacketProcessor())->getLookupTable();
}

} /* namespace libfreenect2 */
