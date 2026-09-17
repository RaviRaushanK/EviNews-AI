module.exports = (sequelize, DataTypes) => {
  const Source = sequelize.define('Source', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the news source'
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      comment: 'Display name of the news source'
    },
    url: {
      type: DataTypes.STRING(512),
      allowNull: true,
      unique: true,
      comment: 'Primary website URL of the source'
    },
    rss_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
      unique: true,
      comment: 'RSS feed URL for the source'
    },
    api_identifier: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Identifier used by the News API (e.g., "bbc-news")'
    }
  }, {
    tableName: 'sources',
    timestamps: true,
    underscored: false,
    comment: 'News sources providing articles for analysis'
  });

  Source.associate = (models) => {
    Source.hasMany(models.Article, {
      foreignKey: 'source_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
  };

  return Source;
};