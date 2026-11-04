import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a JPEG buffer to Cloudinary as an image resource.
 *
 * @param {Buffer} buffer  - Raw JPEG bytes from the ESP32-CAM
 * @param {object} meta    - { returnId, boxId }
 * @returns {Promise<{ url, publicId, bytes, format }>}
 */
export const uploadImageToCloud = (buffer, meta = {}) =>
    new Promise((resolve, reject) => {
        const folder = `cartify/returns/${meta.returnId || 'unknown'}`;
        const publicId = `box-${meta.boxId || 'x'}-${Date.now()}`;

        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'image',
                folder,
                public_id: publicId,
                overwrite: false,
                context: {
                    return_id: meta.returnId || '',
                    box_id: meta.boxId || '',
                    captured_at: new Date().toISOString(),
                },
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id,
                    bytes: result.bytes || 0,
                    format: result.format || 'jpg',
                });
            }
        );

        stream.end(buffer);
    });

/**
 * Delete an image from Cloudinary.
 *
 * @param {string} publicId
 */
export const deleteImageFromCloud = (publicId) =>
    cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
