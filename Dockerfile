FROM node:20
WORKDIR /usr/src/app
COPY package*.json ./
RUN apt-get update && apt-get install -y python3 python3-pip openjdk-17-jdk gcc g++ && ln -s /usr/bin/python3 /usr/bin/python
RUN npm install
COPY . .
ENV PORT=8000
EXPOSE $PORT
CMD ["node", "app.js"]