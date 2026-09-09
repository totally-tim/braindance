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
 * Braindance project: the colour decoder became a caller's choice. A
 * ColorDecoder enum and a defaultColorDecoder() reader are declared here, and
 * every pipeline class gained a constructor overload taking one. Every altered
 * region below is marked "LOCAL EDIT"; third_party/UPSTREAM.md carries the
 * reasoning.
 */

/** @file packet_pipeline.h Packet pipe line definitions. */

#ifndef PACKET_PIPELINE_H_
#define PACKET_PIPELINE_H_

#include <libfreenect2/config.h>

#include <stdlib.h>

namespace libfreenect2
{

class DataCallback;
class RgbPacketProcessor;
class DepthPacketProcessor;
class PacketPipelineComponents;

/** @defgroup pipeline Packet Pipelines
 * Implement various methods to decode color and depth images with different performance and platform support
 *
 * You can construct a specific PacketPipeline object and provide it to Freenect2::openDevice().
 */
///@{

// LOCAL EDIT: the colour decoder, named so a caller can pick one.
/** Which decoder turns the colour camera's JPEG packets into images.
 *
 * An enumerator exists only where this build can construct that decoder, so a value naming a
 * decoder is always a decoder the pipeline will use. Nothing substitutes: a decoder that fails
 * to start, or that fails on a frame, leaves good() false and delivers no more colour rather
 * than quietly handing the work to another decoder.
 */
enum class ColorDecoder
{
#ifdef LIBFREENECT2_WITH_VT_SUPPORT
  VideoToolbox,
#endif
#ifdef LIBFREENECT2_WITH_TURBOJPEG_SUPPORT
  TurboJPEG,
#endif
#ifdef LIBFREENECT2_WITH_TEGRAJPEG_SUPPORT
  TegraJPEG,
#endif
#ifdef LIBFREENECT2_WITH_VAAPI_SUPPORT
  VAAPI,
#endif
};

// LOCAL EDIT: what a pipeline constructed without a decoder will use.
/** The decoder a pipeline constructed without one uses. */
LIBFREENECT2_API ColorDecoder defaultColorDecoder();

/** Base class for other pipeline classes.
 * Methods in this class are reserved for internal use.
 */
class LIBFREENECT2_API PacketPipeline
{
public:
  typedef DataCallback PacketParser;

  PacketPipeline();
  virtual ~PacketPipeline();

  virtual PacketParser *getRgbPacketParser() const;
  virtual PacketParser *getIrPacketParser() const;

  virtual RgbPacketProcessor *getRgbPacketProcessor() const;
  virtual DepthPacketProcessor *getDepthPacketProcessor() const;
protected:
  PacketPipelineComponents *comp_;
};

 class LIBFREENECT2_API DumpPacketPipeline: public PacketPipeline
 {
 public:
   DumpPacketPipeline();
   virtual ~DumpPacketPipeline();

   // These are all required to decode depth data
   const unsigned char* getDepthP0Tables(size_t* length);

   const float* getDepthXTable(size_t* length);
   const float* getDepthZTable(size_t* length);
   const short* getDepthLookupTable(size_t* length);
 };

/** Pipeline with CPU depth processing. */
class LIBFREENECT2_API CpuPacketPipeline : public PacketPipeline
{
public:
  CpuPacketPipeline();
  // LOCAL EDIT: an overload rather than a default argument, which would bake today's default
  // into every caller's object file.
  CpuPacketPipeline(ColorDecoder decoder);
  virtual ~CpuPacketPipeline();
};

#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
/** Pipeline with OpenGL depth processing. */
class LIBFREENECT2_API OpenGLPacketPipeline : public PacketPipeline
{
protected:
  void *parent_opengl_context_;
  bool debug_;
public:
  OpenGLPacketPipeline(void *parent_opengl_context = 0, bool debug = false);
  // LOCAL EDIT: see CpuPacketPipeline.
  OpenGLPacketPipeline(void *parent_opengl_context, bool debug, ColorDecoder decoder);
  virtual ~OpenGLPacketPipeline();
};
#endif // LIBFREENECT2_WITH_OPENGL_SUPPORT

#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
/** Pipeline with OpenCL depth processing. */
class LIBFREENECT2_API OpenCLPacketPipeline : public PacketPipeline
{
protected:
  const int deviceId;
public:
  OpenCLPacketPipeline(const int deviceId = -1);
  // LOCAL EDIT: see CpuPacketPipeline. ColorDecoder is scoped, so it cannot promote to int and
  // bind to the deviceId overload above.
  OpenCLPacketPipeline(const int deviceId, ColorDecoder decoder);
  virtual ~OpenCLPacketPipeline();
};

/*
 * The class below implement a depth packet processor using the phase unwrapping
 * algorithm described in the paper "Efficient Phase Unwrapping using Kernel
 * Density Estimation", ECCV 2016, Felix Järemo Lawin, Per-Erik Forssen and
 * Hannes Ovren, see http://www.cvl.isy.liu.se/research/datasets/kinect2-dataset/.
 */
class LIBFREENECT2_API OpenCLKdePacketPipeline : public PacketPipeline
{
protected:
  const int deviceId;
public:
  OpenCLKdePacketPipeline(const int deviceId = -1);
  // LOCAL EDIT: see CpuPacketPipeline.
  OpenCLKdePacketPipeline(const int deviceId, ColorDecoder decoder);
  virtual ~OpenCLKdePacketPipeline();
};
#endif // LIBFREENECT2_WITH_OPENCL_SUPPORT

#ifdef LIBFREENECT2_WITH_CUDA_SUPPORT
class LIBFREENECT2_API CudaPacketPipeline : public PacketPipeline
{
protected:
  const int deviceId;
public:
  CudaPacketPipeline(const int deviceId = -1);
  // LOCAL EDIT: see CpuPacketPipeline.
  CudaPacketPipeline(const int deviceId, ColorDecoder decoder);
  virtual ~CudaPacketPipeline();
};

/*
 * The class below implement a depth packet processor using the phase unwrapping
 * algorithm described in the paper "Efficient Phase Unwrapping using Kernel
 * Density Estimation", ECCV 2016, Felix Järemo Lawin, Per-Erik Forssen and
 * Hannes Ovren, see http://www.cvl.isy.liu.se/research/datasets/kinect2-dataset/.
 */
class LIBFREENECT2_API CudaKdePacketPipeline : public PacketPipeline
{
protected:
  const int deviceId;
public:
  CudaKdePacketPipeline(const int deviceId = -1);
  // LOCAL EDIT: see CpuPacketPipeline.
  CudaKdePacketPipeline(const int deviceId, ColorDecoder decoder);
  virtual ~CudaKdePacketPipeline();
};
#endif // LIBFREENECT2_WITH_CUDA_SUPPORT

///@}
} /* namespace libfreenect2 */
#endif /* PACKET_PIPELINE_H_ */
