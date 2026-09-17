module.exports = (sequelize, DataTypes) => {
  const EventArticle = sequelize.define('EventArticle', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the event-article link'
    },
    event_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to events.id'
    },
    article_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to articles.id'
    },
    cluster_score: {
      type: DataTypes.FLOAT,
      allowNull: true,
      comment: 'Confidence score from the clustering algorithm'
    }
  }, {
    tableName: 'event_articles',
    timestamps: true,
    underscored: false,
    comment: 'Junction table linking articles to events',
    indexes: [
      {
        name: 'idx_event_articles_event_id',
        fields: ['event_id']
      },
      {
        name: 'idx_event_articles_article_id',
        fields: ['article_id']
      },
      {
        name: 'idx_event_articles_unique',
        fields: ['event_id', 'article_id'],
        unique: true
      }
    ]
  });

  return EventArticle;
};