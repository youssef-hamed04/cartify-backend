import { v2 as cloudinary } from 'cloudinary';
import { readFileSync } from 'fs';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadToCloudinary = (file, folder = 'cartify/products') =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => (result ? resolve(result) : reject(error))
    );
    stream.end(file.buffer ? file.buffer : readFileSync(file.path));
  });

export const deleteFromCloudinary = (publicId) =>
  cloudinary.uploader.destroy(publicId);

export default cloudinary;
